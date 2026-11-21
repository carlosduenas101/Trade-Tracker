"""
Mission Control: one screen that answers "what do I have open, everywhere?"

It reads what the Position Hub already collects (Bitunix by API, KCEX and
LBank by the page readers) and adds the risk view on top:

* accounts   : the accounts the owner trades on (KCEX Main, KCEX 2, Bitunix,
               LBank by default). An account is matched to Hub data by its name,
               which is the "device" value the reader or API key was set up with.
               Each account shows a feed status: live, stale, error or no feed.
* positions  : every open position with an estimated mark price, ROE, distance
               to liquidation, ladder progress and distance to the next entry.
* totals     : margin, unrealized P&L, notional, closest-to-liq, by account and
               by asset.

Mark price is ESTIMATED from the position's own numbers (no extra exchange
call): long  mark = avg + uPnL / qty, short mark = avg - uPnL / qty.
Every quantity the Hub stores is in base coin, so this holds for all sources.

Routes (owner only, same rule as the Hub and the Fund Pool)
  GET /mission/summary
  GET /mission/accounts
  PUT /mission/accounts
"""

from __future__ import annotations

import re
import secrets
import threading
import time
from datetime import datetime
from typing import Literal, Optional

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import Column, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Session

import hub
from auth import require_pool_owner
from database import Base, User, get_db

# Risk bands on distance to liquidation, in % of the mark price
LIQ_DANGER_PCT = 5.0
LIQ_WARN_PCT = 15.0
MAX_ACCOUNTS = 12
UNLISTED_FEED_MAX_AGE = 3600   # seconds

DEFAULT_ACCOUNTS = [
    {"name": "KCEX Main", "exchange": "kcex"},
    {"name": "KCEX 2", "exchange": "kcex"},
    {"name": "Bitunix", "exchange": "bitunix"},
    {"name": "LBank", "exchange": "lbank"},
]
API_EXCHANGES = {"bitunix"}   # read by API key; the others by a page reader


class MissionAccount(Base):
    __tablename__ = "mission_accounts"
    __table_args__ = (UniqueConstraint("user_id", "name", name="ux_mission_accounts_name"),)

    id       = Column(Integer, primary_key=True, autoincrement=True)
    user_id  = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name     = Column(String(40), nullable=False)
    exchange = Column(String(10), nullable=False)
    position = Column(Integer, nullable=False, default=0)


# ═══════════════════════════════════════════════════════════════════════════
# Live price for trades entered by hand (no feed reads those accounts)
# ═══════════════════════════════════════════════════════════════════════════

PRICE_URL = "https://fapi.bitunix.com/api/v1/futures/market/kline"
PRICE_TTL = 10        # seconds a fetched price is reused
PRICE_FAIL_TTL = 30   # seconds a failed symbol is not retried
_price_cache: dict[str, tuple[float, Optional[float]]] = {}
_price_lock = threading.Lock()


def live_price(symbol: str) -> Optional[float]:
    """Last 1m close on Bitunix futures (same feed the calculator uses). None if unavailable.
    One quick try, cached, so a slow exchange never stalls Mission Control."""
    sym = norm_symbol(symbol)
    now = time.time()
    with _price_lock:
        hit = _price_cache.get(sym)
        if hit and now - hit[0] < (PRICE_TTL if hit[1] is not None else PRICE_FAIL_TTL):
            return hit[1]
    price = None
    try:
        r = requests.get(PRICE_URL, params={"symbol": sym, "interval": "1m", "limit": 2,
                                            "endTime": int(now * 1000)}, timeout=4)
        body = r.json()
        rows = (body.get("data") or []) if body.get("code") == 0 else []
        if rows:
            price = float(max(rows, key=lambda x: int(x["time"]))["close"])
    except Exception:
        price = None
    with _price_lock:
        _price_cache[sym] = (now, price)
    return price


def liq_estimate(side: str, avg: float, leverage: float) -> Optional[float]:
    """Isolated-margin liquidation ignoring maintenance margin and fees:
    long avg x (1 - 1/L), short avg x (1 + 1/L). Slightly early-warning vs the exchange's own."""
    if not avg or not leverage or leverage <= 0:
        return None
    return avg * (1 - 1 / leverage) if side == "long" else avg * (1 + 1 / leverage)


def manual_upnl(side: str, avg: float, qty: float, mark: Optional[float]) -> Optional[float]:
    if mark is None or not avg or not qty:
        return None
    return (mark - avg) * qty if side == "long" else (avg - mark) * qty


# ═══════════════════════════════════════════════════════════════════════════
# Pure math (unit-tested with hand-checked numbers)
# ═══════════════════════════════════════════════════════════════════════════

def mark_estimate(side: str, avg: Optional[float], qty: Optional[float],
                  upnl: Optional[float]) -> Optional[float]:
    if not avg or not qty or qty <= 0 or upnl is None:
        return None
    m = avg + upnl / qty if side == "long" else avg - upnl / qty
    return m if m > 0 else None


def liq_distance_pct(side: str, mark: Optional[float], liq: Optional[float]) -> Optional[float]:
    """How far price can move against the position before liquidation, in % of mark.
    Negative means the mark is already past the liq price (data is off or it is liquidating)."""
    if not mark or not liq or liq <= 0:
        return None
    d = (mark - liq) / mark if side == "long" else (liq - mark) / mark
    return d * 100.0


def risk_band(dist: Optional[float]) -> str:
    if dist is None:
        return "unknown"
    if dist < LIQ_DANGER_PCT:
        return "danger"
    if dist < LIQ_WARN_PCT:
        return "warn"
    return "ok"


def roe_pct(upnl: Optional[float], margin: Optional[float]) -> Optional[float]:
    if upnl is None or not margin or margin <= 0:
        return None
    return upnl / margin * 100.0


def base_asset(symbol: str) -> str:
    s = re.sub(r"[^A-Z0-9]", "", (symbol or "").upper())
    for q in ("USDT", "USDC", "USD"):
        if s.endswith(q) and len(s) > len(q):
            return s[: -len(q)]
    return s


def norm_symbol(symbol: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (symbol or "").upper())


# ═══════════════════════════════════════════════════════════════════════════
# Accounts
# ═══════════════════════════════════════════════════════════════════════════

class AccountItem(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    exchange: Literal["kcex", "bitunix", "lbank"]

    @field_validator("name")
    @classmethod
    def _clean(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Account name cannot be blank")
        return v


class AccountsBody(BaseModel):
    accounts: list[AccountItem] = Field(default_factory=list, max_length=MAX_ACCOUNTS)

    @field_validator("accounts")
    @classmethod
    def _unique(cls, items: list[AccountItem]) -> list[AccountItem]:
        seen: set[str] = set()
        for it in items:
            k = it.name.casefold()
            if k in seen:
                raise ValueError(f"Duplicate account name: {it.name}")
            seen.add(k)
        return items


def load_accounts(db: Session, user_id: int) -> tuple[list[dict], bool]:
    rows = (db.query(MissionAccount).filter_by(user_id=user_id)
            .order_by(MissionAccount.position, MissionAccount.id).all())
    if not rows:
        return [dict(a) for a in DEFAULT_ACCOUNTS], False
    return [{"name": r.name, "exchange": r.exchange} for r in rows], True


# ═══════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════

def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() + "Z" if dt else None


def _feed_status(acc: dict, feeds: list, creds: list, pos_rows: list = ()) -> dict:
    """live | stale | error | no_feed, with the age of the last report.
    A position row refreshed by a feed counts as a report too, so a server still
    running the ingest code from before hub_feeds existed is not shown as "no feed"."""
    match = lambda r: r.device.casefold() == acc["name"].casefold() and r.exchange == acc["exchange"]
    mine = [f for f in feeds if match(f)]
    seen = [r.last_seen_at for r in pos_rows if match(r) and r.last_seen_at and r.source != "manual"]
    last = max([f.last_at for f in mine] + seen, default=None)
    age = hub._age(last)
    my_creds = [c for c in creds if c.device.casefold() == acc["name"].casefold()
                and c.exchange == acc["exchange"]]
    err = next((c.last_error for c in my_creds if c.active and c.last_error), None)
    via = "api" if my_creds else ("browser" if (mine or seen) else
                                  ("api" if acc["exchange"] in API_EXCHANGES else "browser"))
    limit = hub.API_STALE_SECONDS if via == "api" else hub.BROWSER_STALE_SECONDS
    manual = any(match(r) and r.source == "manual" for r in pos_rows)
    if err and (age is None or age > limit):
        status = "error"
    elif last is None:
        status, via = ("manual", "manual") if manual else ("no_feed", via)
    elif age > limit:
        status = "stale"
    else:
        status = "live"
    return {"status": status, "via": via, "age_seconds": age, "last_at": _iso(last),
            "error": err, "paused": bool(my_creds) and not any(c.active for c in my_creds)}


def _ladder_progress(p: dict, ladders: list, entries: dict) -> Optional[dict]:
    for lad in ladders:
        if (lad.exchange == p["exchange"] and lad.device == p["device"]
                and norm_symbol(lad.symbol) == norm_symbol(p["symbol"]) and lad.side == p["side"]):
            es = entries.get(lad.id, [])
            filled = 1 + sum(1 for e in es if e.status == "filled")   # E1 is the trade you opened
            return {"filled": filled, "total": 1 + len(es), "preset": lad.preset, "status": lad.status}
    return None


def build_summary(db: Session, user_id: int) -> dict:
    accounts, saved = load_accounts(db, user_id)
    pos_rows = (db.query(hub.HubPosition).filter_by(user_id=user_id, status="open")
                .order_by(hub.HubPosition.device, hub.HubPosition.symbol).all())
    orders = db.query(hub.HubOrder).filter_by(user_id=user_id).all()
    feeds = db.query(hub.HubFeed).filter_by(user_id=user_id).all()
    creds = db.query(hub.HubCredential).filter_by(user_id=user_id).all()

    import hub_ladder  # lazy, like the Hub poller
    ladders = (db.query(hub_ladder.HubLadder)
               .filter(hub_ladder.HubLadder.user_id == user_id,
                       hub_ladder.HubLadder.status.in_(("arming", "armed", "closing"))).all())
    entries: dict[int, list] = {}
    if ladders:
        for e in (db.query(hub_ladder.HubLadderEntry)
                  .filter(hub_ladder.HubLadderEntry.ladder_id.in_([l.id for l in ladders])).all()):
            entries.setdefault(e.ladder_id, []).append(e)

    # Accounts seen in the data but not in the list still show up, flagged.
    # A leftover feed (renamed key, old reader) is dropped once it has been silent
    # for UNLISTED_FEED_MAX_AGE and holds no open trades and no API key.
    known = {(a["name"].casefold(), a["exchange"]) for a in accounts}
    recent_feeds = [f for f in feeds if (hub._age(f.last_at) or 0) <= UNLISTED_FEED_MAX_AGE]
    for src in list(pos_rows) + list(recent_feeds) + list(creds):
        key = (src.device.casefold(), src.exchange)
        if key not in known:
            known.add(key)
            accounts.append({"name": src.device, "exchange": src.exchange, "unlisted": True})

    positions = []
    for row in pos_rows:
        p = hub._position_out(row, orders)
        p["manual"] = row.source == "manual"
        p["liq_estimated"] = False
        if p["manual"]:
            mark = live_price(p["symbol"])
            p["unrealized_pnl"] = manual_upnl(p["side"], p["avg_entry"], p["qty"], mark)
            p["stale"] = False
            p["price_missing"] = mark is None
            if not p["liq_price"]:
                p["liq_price"], p["liq_estimated"] = liq_estimate(p["side"], p["avg_entry"], p["leverage"]), True
        else:
            mark = mark_estimate(p["side"], p["avg_entry"], p["qty"], p["unrealized_pnl"])
        dist = liq_distance_pct(p["side"], mark, p["liq_price"])
        nxt = p["pending_entries"][0] if p["pending_entries"] else None
        p.update({
            "account": p["device"],
            "asset": base_asset(p["symbol"]),
            "mark_est": mark,
            "notional": (p["qty"] or 0) * (mark or p["avg_entry"] or 0),
            "roe_pct": roe_pct(p["unrealized_pnl"], p["margin"]),
            "liq_distance_pct": dist,
            "risk": risk_band(dist),
            "next_entry": None if not nxt else {
                "price": nxt["price"], "qty": nxt["qty"],
                "distance_pct": (abs(mark - nxt["price"]) / mark * 100.0) if mark else None},
            "ladder": _ladder_progress(p, ladders, entries),
        })
        positions.append(p)

    def agg(items: list[dict]) -> dict:
        margin = sum(i["margin"] or 0 for i in items)
        upnl = sum(i["unrealized_pnl"] or 0 for i in items)
        dists = [i for i in items if i["liq_distance_pct"] is not None]
        closest = min(dists, key=lambda i: i["liq_distance_pct"]) if dists else None
        return {"open": len(items), "margin": margin, "upnl": upnl,
                "roe_pct": roe_pct(upnl, margin),
                "notional": sum(i["notional"] for i in items),
                "longs": sum(1 for i in items if i["side"] == "long"),
                "shorts": sum(1 for i in items if i["side"] == "short"),
                "at_risk": sum(1 for i in items if i["risk"] in ("danger", "warn")),
                "closest": None if not closest else {
                    "account": closest["account"], "symbol": closest["symbol"],
                    "side": closest["side"], "liq_distance_pct": closest["liq_distance_pct"],
                    "risk": closest["risk"]}}

    acc_out = []
    for a in accounts:
        mine = [p for p in positions
                if p["account"].casefold() == a["name"].casefold() and p["exchange"] == a["exchange"]]
        acc_out.append({**a, "unlisted": bool(a.get("unlisted")),
                        "feed": _feed_status(a, feeds, creds, pos_rows), **agg(mine)})

    assets: dict[str, list] = {}
    for p in positions:
        assets.setdefault(p["asset"], []).append(p)
    asset_out = sorted(({"asset": k, "accounts": sorted({p["account"] for p in v}), **agg(v)}
                        for k, v in assets.items()), key=lambda x: -x["margin"])

    return {"server_time": int(time.time()), "poll_seconds": hub.POLL_SECONDS,
            "accounts_saved": saved,
            "thresholds": {"danger_pct": LIQ_DANGER_PCT, "warn_pct": LIQ_WARN_PCT},
            "totals": agg(positions), "accounts": acc_out, "assets": asset_out,
            "positions": positions}


# ═══════════════════════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════════════════════

router = APIRouter(prefix="/mission", tags=["Mission Control"])


@router.get("/summary")
def summary(db: Session = Depends(get_db), user: User = Depends(require_pool_owner)):
    return build_summary(db, user.id)


@router.get("/accounts")
def get_accounts(db: Session = Depends(get_db), user: User = Depends(require_pool_owner)):
    accounts, saved = load_accounts(db, user.id)
    return {"accounts": accounts, "saved": saved}


@router.put("/accounts")
def put_accounts(body: AccountsBody, db: Session = Depends(get_db),
                 user: User = Depends(require_pool_owner)):
    db.query(MissionAccount).filter_by(user_id=user.id).delete()
    for i, a in enumerate(body.accounts):
        db.add(MissionAccount(user_id=user.id, name=a.name, exchange=a.exchange, position=i))
    db.commit()
    accounts, saved = load_accounts(db, user.id)
    return {"accounts": accounts, "saved": saved}



# ── Trades entered by hand (accounts no feed can read, e.g. KCEX 2 on its own phone) ──

class ManualTrade(BaseModel):
    account: str = Field(min_length=1, max_length=40)
    exchange: Literal["kcex", "bitunix", "lbank"]
    symbol: str = Field(min_length=2, max_length=30, pattern=r"^[A-Za-z0-9/_\-]+$")
    side: Literal["long", "short"]
    leverage: float = Field(gt=0, le=200)
    avg_entry: float = Field(gt=0)
    margin: float = Field(gt=0)               # $ margin, as you think of trade size
    liq_price: Optional[float] = Field(default=None, gt=0)
    tp_price: Optional[float] = Field(default=None, gt=0)
    sl_price: Optional[float] = Field(default=None, gt=0)

    @field_validator("account")
    @classmethod
    def _clean(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Account name cannot be blank")
        return v


def _manual_write(db: Session, row: "hub.HubPosition", body: ManualTrade) -> None:
    row.exchange, row.device = body.exchange, body.account
    row.symbol, row.side = norm_symbol(body.symbol), body.side
    row.leverage, row.avg_entry, row.margin = body.leverage, body.avg_entry, body.margin
    row.qty = body.margin * body.leverage / body.avg_entry      # base-coin qty from margin x leverage
    row.liq_price, row.unrealized_pnl = body.liq_price, None
    row.margin_mode, row.status, row.last_seen_at = "isolated", "open", datetime.utcnow()
    db.query(hub.HubOrder).filter(hub.HubOrder.user_id == row.user_id, hub.HubOrder.source == "manual",
                                  hub.HubOrder.order_id.like(row.external_id + ":%")).delete(synchronize_session=False)
    exit_side = "sell" if body.side == "long" else "buy"
    for kind, price in (("tp", body.tp_price), ("sl", body.sl_price)):
        if price:
            db.add(hub.HubOrder(user_id=row.user_id, exchange=row.exchange, device=row.device, source="manual",
                                order_id=f"{row.external_id}:{kind}", symbol=row.symbol, side=exit_side,
                                kind="exit", price=price, qty=row.qty, last_seen_at=datetime.utcnow(),
                                tp_price=price if kind == "tp" else None,
                                sl_price=price if kind == "sl" else None))


def _manual_row(db: Session, user_id: int, pos_id: int) -> "hub.HubPosition":
    row = db.query(hub.HubPosition).filter_by(id=pos_id, user_id=user_id, source="manual").first()
    if not row:
        raise HTTPException(status_code=404, detail="Manual trade not found.")
    return row


@router.post("/manual", status_code=201)
def add_manual(body: ManualTrade, db: Session = Depends(get_db), user: User = Depends(require_pool_owner)):
    row = hub.HubPosition(user_id=user.id, exchange=body.exchange, device=body.account, source="manual",
                          external_id="m-" + secrets.token_hex(6), symbol=norm_symbol(body.symbol),
                          side=body.side, qty=0.0, opened_at=datetime.utcnow())
    db.add(row)
    _manual_write(db, row, body)
    db.commit()
    return {"id": row.id}


@router.put("/manual/{pos_id}")
def edit_manual(pos_id: int, body: ManualTrade, db: Session = Depends(get_db),
                user: User = Depends(require_pool_owner)):
    row = _manual_row(db, user.id, pos_id)
    if row.status != "open":
        raise HTTPException(status_code=409, detail="This trade is already closed.")
    _manual_write(db, row, body)
    db.commit()
    return {"id": row.id}


@router.delete("/manual/{pos_id}", status_code=204)
def close_manual(pos_id: int, db: Session = Depends(get_db), user: User = Depends(require_pool_owner)):
    """Marks the trade closed (kept for history) and removes its TP/SL."""
    row = _manual_row(db, user.id, pos_id)
    row.status, row.closed_at = "closed", datetime.utcnow()
    db.query(hub.HubOrder).filter(hub.HubOrder.user_id == user.id, hub.HubOrder.source == "manual",
                                  hub.HubOrder.order_id.like(row.external_id + ":%")).delete(synchronize_session=False)
    db.commit()
