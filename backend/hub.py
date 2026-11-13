"""
Position Hub: one place that knows every open trade, on which exchange and on
which device.

Sources
-------
* Bitunix : read through the futures REST API (signed requests).
* LBank   : its public docs have no private futures endpoints, so the LBank page
            reader (frontend/lbank_reader.js) pushes snapshots, like KCEX. The API
            client below stays as an option if LBank ever supplies the docs.
* KCEX    : no futures API, so a browser tab pushes a snapshot of what the page
            shows to POST /hub/kcex/snapshot (frontend/kcex_reader.js).

Device tagging
--------------
Every API key belongs to one device (for example "PC-1"). A position read with
that key is tagged with that device, whether it was opened by the hub or by hand
in the exchange app. KCEX snapshots carry the device name explicitly.

Security
--------
* Every route except the KCEX ingest requires the owner login (same rule as the
  Fund Pool: POOL_OWNER_USER_ID, deny by default).
* API secrets are stored encrypted (Fernet, key in HUB_ENCRYPTION_KEY) and are
  never returned by any route. Use trade/read keys only, with no withdraw rights.
* KCEX ingest needs HUB_INGEST_TOKEN and HUB_INGEST_USER_ID; unset means denied.

Routes
------
  POST   /hub/credentials          add an exchange key for a device
  GET    /hub/credentials          list keys (masked) with last sync status
  PATCH  /hub/credentials/{id}     enable / disable a key
  DELETE /hub/credentials/{id}     remove a key
  POST   /hub/sync                 sync every active key right now
  GET    /hub/positions            open positions + pending orders, grouped
  POST   /hub/kcex/snapshot        KCEX browser snapshot (X-Hub-Token header)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import threading
import time
from datetime import datetime
from typing import Literal, Optional

import requests
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import (Boolean, Column, DateTime, Float, ForeignKey, Integer,
                        String, Text, UniqueConstraint)
from sqlalchemy.orm import Session

from auth import require_pool_owner
from database import Base, SessionLocal, User, get_db

log = logging.getLogger(__name__)

POLL_SECONDS = 15
HTTP_TIMEOUT = 10
API_STALE_SECONDS = 60       # an API-sourced row older than this is flagged stale
BROWSER_STALE_SECONDS = 180  # a KCEX snapshot older than this is flagged stale
EXCHANGES = ("bitunix", "lbank", "kcex")


# ═══════════════════════════════════════════════════════════════════════════
# Tables
# ═══════════════════════════════════════════════════════════════════════════

class HubCredential(Base):
    __tablename__ = "hub_credentials"

    id            = Column(Integer, primary_key=True, autoincrement=True)
    user_id       = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    exchange      = Column(String(10), nullable=False)             # bitunix | lbank
    device        = Column(String(40), nullable=False)             # PC-1, PC-2, ...
    label         = Column(String(60), nullable=True)
    api_key_enc   = Column(Text, nullable=False)
    api_secret_enc = Column(Text, nullable=False)
    key_hint      = Column(String(20), nullable=False)             # masked, safe to show
    active        = Column(Boolean, nullable=False, default=True)
    last_sync_at  = Column(DateTime, nullable=True)
    last_error    = Column(String(300), nullable=True)
    created_at    = Column(DateTime, default=datetime.utcnow, nullable=False)


class HubPosition(Base):
    __tablename__ = "hub_positions"
    __table_args__ = (UniqueConstraint("user_id", "exchange", "device", "source", "external_id",
                                       name="ux_hub_positions_identity"),)

    id            = Column(Integer, primary_key=True, autoincrement=True)
    user_id       = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    exchange      = Column(String(10), nullable=False, index=True)
    device        = Column(String(40), nullable=False)
    credential_id = Column(Integer, nullable=True)
    source        = Column(String(8), nullable=False)               # api | browser
    external_id   = Column(String(80), nullable=False)
    symbol        = Column(String(30), nullable=False)
    side          = Column(String(5), nullable=False)               # long | short
    qty           = Column(Float, nullable=False)
    avg_entry     = Column(Float, nullable=True)
    leverage      = Column(Float, nullable=True)
    margin        = Column(Float, nullable=True)                    # $ of margin locked
    unrealized_pnl = Column(Float, nullable=True)
    liq_price     = Column(Float, nullable=True)
    margin_mode   = Column(String(10), nullable=True)
    status        = Column(String(6), nullable=False, default="open", index=True)  # open | closed
    opened_at     = Column(DateTime, nullable=True)
    closed_at     = Column(DateTime, nullable=True)
    last_seen_at  = Column(DateTime, nullable=False, default=datetime.utcnow)


class HubOrder(Base):
    __tablename__ = "hub_orders"

    id            = Column(Integer, primary_key=True, autoincrement=True)
    user_id       = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    exchange      = Column(String(10), nullable=False, index=True)
    device        = Column(String(40), nullable=False)
    credential_id = Column(Integer, nullable=True)
    source        = Column(String(8), nullable=False)
    order_id      = Column(String(80), nullable=False)
    client_id     = Column(String(80), nullable=True)
    symbol        = Column(String(30), nullable=False)
    side          = Column(String(4), nullable=False)               # buy | sell
    kind          = Column(String(5), nullable=False)               # entry | exit
    price         = Column(Float, nullable=True)
    qty           = Column(Float, nullable=False)
    filled_qty    = Column(Float, nullable=False, default=0.0)
    status        = Column(String(12), nullable=True)
    tp_price      = Column(Float, nullable=True)
    sl_price      = Column(Float, nullable=True)
    last_seen_at  = Column(DateTime, nullable=False, default=datetime.utcnow)


# ═══════════════════════════════════════════════════════════════════════════
# Secret storage
# ═══════════════════════════════════════════════════════════════════════════

def _fernet():
    from cryptography.fernet import Fernet
    key = os.environ.get("HUB_ENCRYPTION_KEY", "").strip()
    if not key:
        raise HTTPException(status_code=503, detail="HUB_ENCRYPTION_KEY is not set on the server.")
    try:
        return Fernet(key.encode())
    except Exception:
        raise HTTPException(status_code=503, detail="HUB_ENCRYPTION_KEY is not a valid Fernet key.")


def encrypt(text: str) -> str:
    return _fernet().encrypt(text.encode()).decode()


def decrypt(token: str) -> str:
    return _fernet().decrypt(token.encode()).decode()


def mask(key: str) -> str:
    return key if len(key) <= 8 else f"{key[:4]}…{key[-4:]}"


# ═══════════════════════════════════════════════════════════════════════════
# Exchange clients
# ═══════════════════════════════════════════════════════════════════════════

class ExchangeError(Exception):
    pass


class NotConfigured(ExchangeError):
    pass


def _f(v) -> Optional[float]:
    try:
        return None if v in (None, "") else float(v)
    except (TypeError, ValueError):
        return None


def _ms_to_dt(ms) -> Optional[datetime]:
    try:
        return datetime.utcfromtimestamp(int(ms) / 1000.0)
    except (TypeError, ValueError, OverflowError):
        return None


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def bitunix_sign(nonce: str, timestamp: str, api_key: str, secret: str,
                 query: dict, body: str) -> str:
    """sign = SHA256( SHA256(nonce + timestamp + api-key + queryParams + body) + secretKey ).

    queryParams = keys sorted ascending, each written as key+value, no separators.
    body        = the JSON body with all spaces removed ("" when there is none).
    """
    qs = "".join(f"{k}{query[k]}" for k in sorted(query))
    digest = _sha256(nonce + timestamp + api_key + qs + body)
    return _sha256(digest + secret)


class BitunixClient:
    BASE = "https://fapi.bitunix.com"

    def __init__(self, api_key: str, secret: str):
        self.api_key, self.secret = api_key, secret

    def _get(self, path: str, query: Optional[dict] = None) -> dict:
        query = {k: str(v) for k, v in (query or {}).items() if v is not None}
        nonce = secrets.token_hex(16)
        ts = str(int(time.time() * 1000))
        headers = {
            "api-key": self.api_key, "nonce": nonce, "timestamp": ts,
            "sign": bitunix_sign(nonce, ts, self.api_key, self.secret, query, ""),
            "language": "en-US", "Content-Type": "application/json",
        }
        r = requests.get(self.BASE + path, params=query, headers=headers, timeout=HTTP_TIMEOUT)
        try:
            data = r.json()
        except ValueError:
            raise ExchangeError(f"Bitunix HTTP {r.status_code}: non-JSON response")
        if data.get("code") != 0:
            raise ExchangeError(f"Bitunix error {data.get('code')}: {data.get('msg')}")
        return data

    def fetch_state(self) -> tuple[list[dict], list[dict]]:
        pos = self._get("/api/v1/futures/position/get_pending_positions").get("data") or []
        orders: list[dict] = []
        skip = 0
        while True:   # pending orders are paged (max 100 per page)
            page = (self._get("/api/v1/futures/trade/get_pending_orders",
                              {"limit": 100, "skip": skip}).get("data") or {})
            batch = page.get("orderList") or []
            orders += batch
            skip += len(batch)
            if not batch or skip >= int(page.get("total") or 0):
                break
        return [self.norm_position(p) for p in pos], [self.norm_order(o) for o in orders]

    @staticmethod
    def norm_position(p: dict) -> dict:
        liq = _f(p.get("liqPrice"))
        return {
            "external_id": str(p["positionId"]), "symbol": p["symbol"],
            "side": str(p.get("side", "")).lower(), "qty": _f(p.get("qty")) or 0.0,
            "avg_entry": _f(p.get("avgOpenPrice")), "leverage": _f(p.get("leverage")),
            "margin": _f(p.get("margin")), "unrealized_pnl": _f(p.get("unrealizedPNL")),
            "liq_price": liq if liq and liq > 0 else None,
            "margin_mode": str(p.get("marginMode", "")).lower() or None,
            "opened_at": _ms_to_dt(p.get("ctime")),
        }

    @staticmethod
    def norm_order(o: dict) -> dict:
        return {
            "order_id": str(o["orderId"]), "client_id": o.get("clientId") or None,
            "symbol": o["symbol"], "side": str(o.get("side", "")).lower(),
            "kind": "exit" if o.get("reduceOnly") else "entry",
            "price": _f(o.get("price")), "qty": _f(o.get("qty")) or 0.0,
            "filled_qty": _f(o.get("tradeQty")) or 0.0, "status": o.get("status"),
            "tp_price": _f(o.get("tpPrice")), "sl_price": _f(o.get("slPrice")),
        }


def lbank_sign(params: dict, secret: str, api_key: str, signature_method: str,
               timestamp: str, echostr: str) -> str:
    """LBank contract signing, as documented (HmacSHA256 variant).

    1. take every request parameter (+ api_key) and add signature_method,
       timestamp and echostr; sort by name; join as k=v with &
    2. MD5 hex digest of that string, upper-cased
    3. HMAC-SHA256 (hex) of the digest, keyed with the secret
    """
    p = dict(params)
    p.update({"api_key": api_key, "signature_method": signature_method,
              "timestamp": timestamp, "echostr": echostr})
    prepared = "&".join(f"{k}={p[k]}" for k in sorted(p))
    digest = hashlib.md5(prepared.encode()).hexdigest().upper()
    return hmac.new(secret.encode(), digest.encode(), hashlib.sha256).hexdigest()


class LBankClient:
    """LBank perpetual (SwapU) contracts.

    Signing and the base URL are documented. The private endpoints for positions
    and open orders are not in LBank's public docs, so their paths must be set in
    LBANK_POSITIONS_PATH and LBANK_ORDERS_PATH (copy them from the contract API
    docs inside your LBank account). Until they are set the key reports
    "not configured" instead of guessing.
    """
    BASE = "https://lbkperp.lbank.com"

    def __init__(self, api_key: str, secret: str):
        self.api_key, self.secret = api_key, secret

    def _server_time(self) -> str:
        r = requests.get(self.BASE + "/cfd/openApi/v1/pub/getTime", timeout=HTTP_TIMEOUT)
        return str(r.json()["data"])

    def _signed_get(self, path: str, params: Optional[dict] = None) -> dict:
        params = {k: str(v) for k, v in (params or {}).items()}
        ts = self._server_time()
        echostr = secrets.token_hex(16)            # 32 chars, within the 30-40 rule
        method = "HmacSHA256"
        sign = lbank_sign(params, self.secret, self.api_key, method, ts, echostr)
        query = dict(params, api_key=self.api_key, sign=sign)
        headers = {"timestamp": ts, "signature_method": method, "echostr": echostr,
                   "Content-Type": "application/json"}
        r = requests.get(self.BASE + path, params=query, headers=headers, timeout=HTTP_TIMEOUT)
        data = r.json()
        if data.get("result") not in (True, "true"):
            raise ExchangeError(f"LBank error {data.get('error_code')}: {data.get('msg')}")
        return data

    def fetch_state(self) -> tuple[list[dict], list[dict]]:
        pos_path = os.environ.get("LBANK_POSITIONS_PATH", "").strip()
        if not pos_path:
            raise NotConfigured("LBANK_POSITIONS_PATH is not set (private contract endpoint paths "
                                "are not in LBank's public docs).")
        raise NotConfigured("LBank response mapping is pending: send the positions/orders endpoint "
                            "docs from your LBank account to finish this adapter.")


def make_client(cred: HubCredential):
    key, secret = decrypt(cred.api_key_enc), decrypt(cred.api_secret_enc)
    if cred.exchange == "bitunix":
        return BitunixClient(key, secret)
    if cred.exchange == "lbank":
        return LBankClient(key, secret)
    raise ExchangeError(f"No API client for {cred.exchange}")


# ═══════════════════════════════════════════════════════════════════════════
# Sync (shared by the API poller and the KCEX snapshot)
# ═══════════════════════════════════════════════════════════════════════════

def apply_state(db: Session, *, user_id: int, exchange: str, device: str, source: str,
                credential_id: Optional[int], positions: list[dict], orders: list[dict]) -> None:
    """Make the stored rows for (exchange, device, source) match this fresh state."""
    now = datetime.utcnow()
    scope = dict(user_id=user_id, exchange=exchange, device=device, source=source)

    seen = set()
    for p in positions:
        seen.add(p["external_id"])
        row = (db.query(HubPosition).filter_by(**scope, external_id=p["external_id"]).first())
        if row is None:
            row = HubPosition(**scope, external_id=p["external_id"], credential_id=credential_id,
                              symbol=p["symbol"], side=p["side"], qty=p["qty"],
                              opened_at=p.get("opened_at") or now)
            db.add(row)
        elif row.status == "closed":          # same id came back: reopen
            row.status, row.closed_at, row.opened_at = "open", None, p.get("opened_at") or now
        for f in ("symbol", "side", "qty", "avg_entry", "leverage", "margin",
                  "unrealized_pnl", "liq_price", "margin_mode"):
            setattr(row, f, p.get(f))
        row.status, row.last_seen_at = "open", now

    for row in db.query(HubPosition).filter_by(**scope, status="open").all():
        if row.external_id not in seen:       # gone from the exchange: closed
            row.status, row.closed_at = "closed", now

    db.query(HubOrder).filter_by(**scope).delete()
    for o in orders:
        db.add(HubOrder(**scope, credential_id=credential_id, last_seen_at=now,
                        order_id=o["order_id"], client_id=o.get("client_id"), symbol=o["symbol"],
                        side=o["side"], kind=o["kind"], price=o.get("price"), qty=o["qty"],
                        filled_qty=o.get("filled_qty") or 0.0, status=o.get("status"),
                        tp_price=o.get("tp_price"), sl_price=o.get("sl_price")))
    db.commit()


def sync_credential(db: Session, cred: HubCredential) -> None:
    try:
        positions, orders = make_client(cred).fetch_state()
        apply_state(db, user_id=cred.user_id, exchange=cred.exchange, device=cred.device,
                    source="api", credential_id=cred.id, positions=positions, orders=orders)
        cred.last_error = None
    except NotConfigured as exc:
        db.rollback()
        cred.last_error = f"not configured: {exc}"[:300]
    except Exception as exc:      # network / auth / parse: keep old rows, record why
        db.rollback()
        cred.last_error = f"{type(exc).__name__}: {exc}"[:300]
        log.warning("hub sync failed for credential %s (%s/%s): %s", cred.id, cred.exchange, cred.device, exc)
    cred.last_sync_at = datetime.utcnow()
    db.commit()


def sync_all(db: Session, user_id: Optional[int] = None) -> int:
    q = db.query(HubCredential).filter(HubCredential.active == True)   # noqa: E712
    if user_id is not None:
        q = q.filter(HubCredential.user_id == user_id)
    creds = q.all()
    for c in creds:
        sync_credential(db, c)
    return len(creds)


_engine_started = False


def start_engine() -> None:
    """Background poller (idempotent)."""
    global _engine_started
    if _engine_started:
        return
    _engine_started = True

    def loop():
        while True:
            time.sleep(POLL_SECONDS)
            db = SessionLocal()
            try:
                sync_all(db)
                import hub_ladder  # lazy: hub_ladder imports hub
                hub_ladder.reconcile_all(db)
            except Exception as exc:
                log.error("hub poller error: %s", exc)
            finally:
                db.close()

    threading.Thread(target=loop, name="hub-poller", daemon=True).start()


# ═══════════════════════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════════════════════

router = APIRouter(prefix="/hub", tags=["Position Hub"])


class CredentialCreate(BaseModel):
    exchange: Literal["bitunix", "lbank"]
    device: str = Field(min_length=1, max_length=40)
    label: Optional[str] = Field(default=None, max_length=60)
    api_key: str = Field(min_length=6)
    api_secret: str = Field(min_length=6)


def _cred_out(c: HubCredential) -> dict:
    return {"id": c.id, "exchange": c.exchange, "device": c.device, "label": c.label,
            "key_hint": c.key_hint, "active": c.active, "last_error": c.last_error,
            "last_sync_at": c.last_sync_at.isoformat() + "Z" if c.last_sync_at else None}


@router.post("/credentials", status_code=201)
def add_credential(body: CredentialCreate, db: Session = Depends(get_db),
                   user: User = Depends(require_pool_owner)):
    cred = HubCredential(user_id=user.id, exchange=body.exchange, device=body.device.strip(),
                         label=body.label, api_key_enc=encrypt(body.api_key.strip()),
                         api_secret_enc=encrypt(body.api_secret.strip()),
                         key_hint=mask(body.api_key.strip()))
    db.add(cred)
    db.commit()
    db.refresh(cred)
    return _cred_out(cred)


@router.get("/credentials")
def list_credentials(db: Session = Depends(get_db), user: User = Depends(require_pool_owner)):
    rows = db.query(HubCredential).filter_by(user_id=user.id).order_by(HubCredential.id).all()
    return [_cred_out(c) for c in rows]


@router.patch("/credentials/{cred_id}")
def toggle_credential(cred_id: int, active: bool, db: Session = Depends(get_db),
                      user: User = Depends(require_pool_owner)):
    c = db.query(HubCredential).filter_by(id=cred_id, user_id=user.id).first()
    if not c:
        raise HTTPException(status_code=404, detail="Credential not found.")
    c.active = active
    db.commit()
    return _cred_out(c)


@router.delete("/credentials/{cred_id}", status_code=204)
def delete_credential(cred_id: int, db: Session = Depends(get_db),
                      user: User = Depends(require_pool_owner)):
    c = db.query(HubCredential).filter_by(id=cred_id, user_id=user.id).first()
    if not c:
        raise HTTPException(status_code=404, detail="Credential not found.")
    db.delete(c)
    db.commit()


@router.post("/sync")
def sync_now(db: Session = Depends(get_db), user: User = Depends(require_pool_owner)):
    n = sync_all(db, user.id)
    return {"synced": n}


def _age(dt: Optional[datetime]) -> Optional[int]:
    return None if dt is None else max(0, int((datetime.utcnow() - dt).total_seconds()))


def _position_out(p: HubPosition, orders: list[HubOrder]) -> dict:
    entry_side = "buy" if p.side == "long" else "sell"
    mine = [o for o in orders if o.symbol == p.symbol and o.device == p.device and o.exchange == p.exchange]
    pend = sorted((o for o in mine if o.kind == "entry" and o.side == entry_side and o.price),
                  key=lambda o: o.price, reverse=(p.side == "long"))   # nearest fill first
    exits = [o for o in mine if o.kind == "exit"]
    age = _age(p.last_seen_at)
    limit = API_STALE_SECONDS if p.source == "api" else BROWSER_STALE_SECONDS
    return {
        "id": p.id, "exchange": p.exchange, "device": p.device, "source": p.source,
        "symbol": p.symbol, "side": p.side, "qty": p.qty, "avg_entry": p.avg_entry,
        "leverage": p.leverage, "margin": p.margin, "unrealized_pnl": p.unrealized_pnl,
        "liq_price": p.liq_price, "margin_mode": p.margin_mode,
        "opened_at": p.opened_at.isoformat() + "Z" if p.opened_at else None,
        "age_seconds": age, "stale": age is None or age > limit,
        "pending_entries": [{"price": o.price, "qty": o.qty, "order_id": o.order_id} for o in pend],
        "exit_orders": [{"price": o.price, "qty": o.qty, "tp": o.tp_price, "sl": o.sl_price,
                         "order_id": o.order_id} for o in exits],
        "tp_price": next((o.tp_price for o in mine if o.tp_price), None),
        "sl_price": next((o.sl_price for o in mine if o.sl_price), None),
    }


@router.get("/positions")
def get_positions(db: Session = Depends(get_db), user: User = Depends(require_pool_owner)):
    pos = (db.query(HubPosition).filter_by(user_id=user.id, status="open")
           .order_by(HubPosition.exchange, HubPosition.device, HubPosition.symbol).all())
    orders = db.query(HubOrder).filter_by(user_id=user.id).all()
    out = [_position_out(p, orders) for p in pos]
    by_device: dict[str, dict] = {}
    for p in out:
        d = by_device.setdefault(p["device"], {"device": p["device"], "open": 0, "margin": 0.0, "upnl": 0.0})
        d["open"] += 1
        d["margin"] += p["margin"] or 0.0
        d["upnl"] += p["unrealized_pnl"] or 0.0
    creds = db.query(HubCredential).filter_by(user_id=user.id).all()
    return {"server_time": int(time.time()), "poll_seconds": POLL_SECONDS,
            "positions": out, "devices": sorted(by_device.values(), key=lambda d: d["device"]),
            "sources": [_cred_out(c) for c in creds]}


# ── KCEX (browser snapshot) ────────────────────────────────────────────────

class KcexPosition(BaseModel):
    symbol: str
    side: Literal["long", "short"]
    qty: float
    avg_entry: Optional[float] = None
    leverage: Optional[float] = None
    margin: Optional[float] = None
    unrealized_pnl: Optional[float] = None
    liq_price: Optional[float] = None
    margin_mode: Optional[str] = None


class KcexOrder(BaseModel):
    symbol: str
    side: Literal["buy", "sell"]
    price: Optional[float] = None
    qty: float
    kind: Literal["entry", "exit"] = "entry"
    order_id: Optional[str] = None
    tp_price: Optional[float] = None
    sl_price: Optional[float] = None


class KcexSnapshot(BaseModel):
    """Browser snapshot. Used by the KCEX reader and, since LBank publishes no
    private futures API, by the LBank page reader (exchange = "lbank")."""
    exchange: Literal["kcex", "lbank"] = "kcex"
    device: str = Field(min_length=1, max_length=40)
    positions: list[KcexPosition] = []
    orders: list[KcexOrder] = []


def _ingest_user_id(x_hub_token: Optional[str]) -> int:
    expected = os.environ.get("HUB_INGEST_TOKEN", "")
    raw_uid = os.environ.get("HUB_INGEST_USER_ID", "").strip()
    if not expected or not raw_uid.isdigit():
        raise HTTPException(status_code=403, detail="Forbidden.")
    if not x_hub_token or not hmac.compare_digest(x_hub_token, expected):
        raise HTTPException(status_code=403, detail="Forbidden.")
    return int(raw_uid)


@router.post("/kcex/snapshot")
def kcex_snapshot(body: KcexSnapshot, db: Session = Depends(get_db),
                  x_hub_token: Optional[str] = Header(default=None)):
    uid = _ingest_user_id(x_hub_token)
    positions = [{"external_id": f"{p.symbol}:{p.side}", **p.model_dump()} for p in body.positions]
    orders = [{"order_id": o.order_id or f"{o.symbol}:{o.side}:{o.price}", "client_id": None,
               "filled_qty": 0.0, "status": "NEW", **o.model_dump(exclude={"order_id"})}
              for o in body.orders]
    apply_state(db, user_id=uid, exchange=body.exchange, device=body.device.strip(), source="browser",
                credential_id=None, positions=positions, orders=orders)
    return {"ok": True, "positions": len(positions), "orders": len(orders)}
