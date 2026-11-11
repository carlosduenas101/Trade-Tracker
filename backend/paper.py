"""
Paper trading — runs the Liq Ladder strategy live on real Bitunix prices,
without placing real orders.

How it works
------------
* A *bot* is one ladder configuration (symbol, side, capital, leverage, ladder
  parameters, entry mode, compounding).
* A background thread wakes up every ``POLL_SECONDS``, downloads the newest
  closed 1-minute candles from the Bitunix public API (one request per symbol)
  and feeds them, in order, to every running bot on that symbol.
* Each candle is processed with exactly the same rules as the calculator's
  probability simulation (frontend/ladder.js):
      fills (limit orders at their price) → SL → liquidation → TP,
      TP is not checked on the candle where E1 fills.
* If the backend was asleep, the missing candles are downloaded and replayed
  (up to ``MAX_CATCHUP_MINUTES``), so results do not depend on uptime.

Entry modes
-----------
  market — E1 opens at the open of the first candle after the previous cycle.
  price  — E1 is a limit order at a fixed price (re-armed after every cycle).
  zone   — E1 is a limit order at the Equilibrium (or Discount, if the price is
           already below Equilibrium) of the 5m swing range, length 50.

Routes (all require login)
--------------------------
  POST   /paper/bots               create and start a bot
  GET    /paper/bots               list bots with stats and the open cycle
  GET    /paper/bots/{id}/cycles   cycle history
  POST   /paper/bots/{id}/stop     pause (open cycle is kept)
  POST   /paper/bots/{id}/start    resume from the current minute
  DELETE /paper/bots/{id}          delete bot and its cycles
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import Column, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Session

import market
from auth import get_current_user
from database import Base, SessionLocal, User, get_db

log = logging.getLogger(__name__)

POLL_SECONDS = 20
MAX_CATCHUP_MINUTES = 7 * 24 * 60
ZONE_SWING_LENGTH = 50
ZONE_REFRESH_SECONDS = 60


# ═══════════════════════════════════════════════════════════════════════════
# Tables
# ═══════════════════════════════════════════════════════════════════════════

class PaperBot(Base):
    __tablename__ = "paper_bots"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    user_id         = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name            = Column(String(80), nullable=True)
    symbol          = Column(String(20), nullable=False, index=True)
    side            = Column(String(5), nullable=False)               # long | short
    leverage        = Column(Float, nullable=False)
    initial_capital = Column(Float, nullable=False)
    params_json     = Column(Text, nullable=False)                    # ladder parameters
    entry_mode      = Column(String(10), nullable=False)              # market | price | zone
    entry_price     = Column(Float, nullable=True)                    # for entry_mode = price
    compound_pct    = Column(Float, nullable=False, default=0.0)      # 0 – 100
    status          = Column(String(10), nullable=False, default="running", index=True)
    balance         = Column(Float, nullable=False)                   # capital used by the next cycle
    withdrawn       = Column(Float, nullable=False, default=0.0)      # profits set aside
    contributed     = Column(Float, nullable=False)                   # initial + refills after losses
    last_candle_ts  = Column(Integer, nullable=False)                 # open time (s) of last processed 1m candle
    last_price      = Column(Float, nullable=True)
    last_error      = Column(String(300), nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at      = Column(DateTime, default=datetime.utcnow, nullable=False)


class PaperCycle(Base):
    __tablename__ = "paper_cycles"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    bot_id      = Column(Integer, ForeignKey("paper_bots.id"), nullable=False, index=True)
    status      = Column(String(5), nullable=False, default="open", index=True)  # open | tp | sl | liq
    capital     = Column(Float, nullable=False)       # margin budget of this cycle
    e1_price    = Column(Float, nullable=False)
    depth       = Column(Integer, nullable=False, default=1)
    fills_json  = Column(Text, nullable=False, default="[]")  # [[entry, price, unix_ts], ...]
    entry_ts    = Column(Integer, nullable=False)     # candle where E1 filled
    exit_price  = Column(Float, nullable=True)
    exit_ts     = Column(Integer, nullable=True)
    pnl         = Column(Float, nullable=True)
    worst_pnl   = Column(Float, nullable=False, default=0.0)   # worst floating P&L seen (candle lows)


# ═══════════════════════════════════════════════════════════════════════════
# Ladder plan — Python port of calcLadder() in frontend/ladder.js
# ═══════════════════════════════════════════════════════════════════════════

DEFAULT_PARAMS = {"e1Pct": 3.0, "e2DistPct": 1.619, "liqBufPct": 1.0, "tpPct": 1.0, "slPct": 2.618, "feePct": 0.06}


def calc_ladder(capital: float, leverage: float, e1_price: float, side: str = "long", **params) -> dict:
    p = {**DEFAULT_PARAMS, **{k: v for k, v in params.items() if v is not None}}
    is_long = side != "short"
    d = 1 if is_long else -1
    fee = p["feePct"] / 100
    L = leverage

    margins: list[float] = []
    remaining, base, k = capital, capital * p["e1Pct"] / 100, 0
    while remaining > capital * 1e-6 and len(margins) < 10:
        take = min(base * 2 ** k, remaining)
        if take < capital * 0.001:
            break
        margins.append(take)
        remaining -= take
        k += 1

    def liq_of(avg: float) -> float:
        return avg * (1 - 1 / L) if is_long else avg * (1 + 1 / L)

    rows: list[dict] = []
    N = Q = entry_fees = liq = 0.0
    prev = e1_price
    for i, margin in enumerate(margins):
        if i == 0:
            price = e1_price
        elif i == 1:
            price = e1_price * (1 - d * p["e2DistPct"] / 100)
        else:
            price = liq * (1 + d * p["liqBufPct"] / 100)
        if i > 0:
            beyond_prev = price < prev if is_long else price > prev
            before_liq = price > liq if is_long else price < liq
            if not (beyond_prev and before_liq):
                break
        notional = margin * L
        N += notional
        Q += notional / price
        entry_fees += notional * fee
        avg = N / Q
        liq = liq_of(avg)
        if i == 0:
            tp = e1_price * (1 + d * p["tpPct"] / 100)
        elif i == 1:
            tp = e1_price
        else:
            tp = avg * (1 + d * p["tpPct"] / 100)
        gross = Q * tp - N if is_long else N - Q * tp
        profit = gross - entry_fees - Q * tp * fee
        rows.append({"n": i + 1, "margin": margin, "price": price, "avg": avg, "liq": liq, "tp": tp,
                     "profit": profit, "qty": Q, "notional_total": N, "entry_fees": entry_fees})
        prev = price

    last = rows[-1]
    sl = last["price"] * (1 - d * p["slPct"] / 100)
    sl_effective = sl > last["liq"] if is_long else sl < last["liq"]
    sl_gross = last["qty"] * sl - last["notional_total"] if is_long else last["notional_total"] - last["qty"] * sl
    return {
        "rows": rows, "is_long": is_long, "fee": fee,
        "sl": sl, "sl_effective": sl_effective,
        "sl_loss": sl_gross - last["entry_fees"] - last["qty"] * sl * fee,
        "liq_loss": -(sum(r["margin"] for r in rows) + last["entry_fees"]),
    }


def floating_pnl(plan: dict, depth: int, price: float) -> float:
    """Unrealised P&L of the first ``depth`` entries at ``price`` (incl. entry fees, excl. exit fee)."""
    r = plan["rows"][depth - 1]
    gross = r["qty"] * price - r["notional_total"] if plan["is_long"] else r["notional_total"] - r["qty"] * price
    return gross - r["entry_fees"]


# ═══════════════════════════════════════════════════════════════════════════
# Candle processing — identical order to ladderSimCycle() in ladder.js
# ═══════════════════════════════════════════════════════════════════════════

def process_open_cycle(plan: dict, cyc: dict, candle: list, is_entry_candle: bool) -> Optional[dict]:
    """Advance an open cycle by one candle. ``cyc`` = {"depth", "fills", "worst"} is mutated.
    Returns {"status", "exit_price", "pnl"} when the cycle closes, else None."""
    t, o, h, l, c = candle
    rows, long_ = plan["rows"], plan["is_long"]
    last = len(rows)
    hit = (lambda p: l <= p) if long_ else (lambda p: h >= p)
    hit_tp = (lambda p: h >= p) if long_ else (lambda p: l <= p)

    while cyc["depth"] < last and hit(rows[cyc["depth"]]["price"]):
        cyc["fills"].append([cyc["depth"] + 1, rows[cyc["depth"]]["price"], int(t)])
        cyc["depth"] += 1
    k = cyc["depth"]
    cyc["worst"] = min(cyc["worst"], floating_pnl(plan, k, l if long_ else h))

    if plan["sl_effective"] and k == last and hit(plan["sl"]):
        return {"status": "sl", "exit_price": plan["sl"], "pnl": plan["sl_loss"]}
    if hit(rows[k - 1]["liq"]):
        return {"status": "liq", "exit_price": rows[k - 1]["liq"], "pnl": plan["liq_loss"]}
    if not is_entry_candle and hit_tp(rows[k - 1]["tp"]):
        return {"status": "tp", "exit_price": rows[k - 1]["tp"], "pnl": rows[k - 1]["profit"]}
    return None


def entry_fill(mode: str, side: str, candle: list, target: Optional[float]) -> Optional[float]:
    """Price at which E1 fills on this candle, or None."""
    t, o, h, l, c = candle
    if mode == "market":
        return o
    if target is None:
        return None
    if side == "long":
        if o <= target:
            return o            # already through the level when the order is live
        return target if l <= target else None
    if o >= target:
        return o
    return target if h >= target else None


# ═══════════════════════════════════════════════════════════════════════════
# Equilibrium / Discount zones (port of the 5m swing structure used in the sims)
# ═══════════════════════════════════════════════════════════════════════════

def zone_levels(bars: list[list[float]], length: int = ZONE_SWING_LENGTH) -> list[tuple]:
    """Swing range after each closed 5m bar: [(close_ts, top, bottom, close), ...] (oldest first).
    Same trailing top/bottom logic as the 5m simulations (LuxAlgo-style swing structure)."""
    n = len(bars)
    hi = [b[2] for b in bars]
    lo = [b[3] for b in bars]
    leg = tt = tb = None
    out: list[tuple] = []
    for j in range(n):
        if j >= length:
            k = j - length
            mx = max(hi[k + 1:j + 1])
            mn = min(lo[k + 1:j + 1])
            nl = 0 if hi[k] > mx else (1 if lo[k] < mn else leg)
            if leg is not None and nl != leg:
                if nl == 0:
                    tt = hi[k]
                else:
                    tb = lo[k]
            leg = nl
        if tt is not None:
            tt = max(tt, hi[j])
        if tb is not None:
            tb = min(tb, lo[j])
        if tt is not None and tb is not None and tt > tb:
            out.append((int(bars[j][0]) + 300, tt, tb, bars[j][4]))
    return out


def zone_target(levels: list[tuple], t: int, side: str) -> Optional[float]:
    """E1 limit for a 1m candle opening at ``t``, from the last 5m bar closed by then.
    Long: Equilibrium top (52.5%) if price is above it, else Discount top (5%), else market.
    Short: mirrored — Equilibrium bottom (47.5%), else Premium bottom (95%), else market."""
    import bisect
    i = bisect.bisect_right([lv[0] for lv in levels], t) - 1 if levels else -1
    if i < 0:
        return None
    _, top, bot, close = levels[i]
    rng = top - bot
    if side == "long":
        eq, dz = bot + 0.525 * rng, bot + 0.05 * rng
        return eq if close > eq else dz if close > dz else close
    eq, pz = bot + 0.475 * rng, bot + 0.95 * rng
    return eq if close < eq else pz if close < pz else close


_zone_cache: dict[str, tuple[float, int, list]] = {}


def bars_5m_since(symbol: str, since_ts: int) -> list:
    """5m bars from 3 days before ``since_ts`` (to establish the swing structure) until now."""
    start = (since_ts - 3 * 86400) // 300 * 300
    cached = _zone_cache.get(symbol)
    if cached and time.time() - cached[0] < ZONE_REFRESH_SECONDS and cached[1] <= start:
        return cached[2]
    until = int(time.time()) // 300 * 300
    bars = market.download_series(symbol, "5m", start, until)
    _zone_cache[symbol] = (time.time(), start, bars)
    return bars


# ═══════════════════════════════════════════════════════════════════════════
# Engine
# ═══════════════════════════════════════════════════════════════════════════

def bot_params(bot: PaperBot) -> dict:
    return {**DEFAULT_PARAMS, **json.loads(bot.params_json or "{}")}


def run_bot_on_candles(db: Session, bot: PaperBot, candles: list, levels: Optional[list] = None) -> None:
    """Feed closed 1m candles (oldest first) to one bot and persist the result."""
    params = bot_params(bot)
    cycle = db.query(PaperCycle).filter(PaperCycle.bot_id == bot.id, PaperCycle.status == "open").first()

    for candle in candles:
        t = int(candle[0])
        if t <= bot.last_candle_ts:
            continue
        entry_candle = False
        if cycle is None:
            target = bot.entry_price if bot.entry_mode == "price" else (zone_target(levels, t, bot.side) if levels else None)
            px = entry_fill(bot.entry_mode, bot.side, candle, target)
            if px is None:
                bot.last_candle_ts = t
                bot.last_price = candle[4]
                continue
            cycle = PaperCycle(bot_id=bot.id, status="open", capital=bot.balance, e1_price=px, depth=1,
                               fills_json=json.dumps([[1, px, t]]), entry_ts=t, worst_pnl=0.0)
            db.add(cycle)
            db.flush()
            entry_candle = True

        plan = calc_ladder(cycle.capital, bot.leverage, cycle.e1_price, bot.side, **params)
        state = {"depth": cycle.depth, "fills": json.loads(cycle.fills_json), "worst": cycle.worst_pnl}
        result = process_open_cycle(plan, state, candle, entry_candle)
        cycle.depth, cycle.fills_json, cycle.worst_pnl = state["depth"], json.dumps(state["fills"]), state["worst"]

        if result:
            cycle.status, cycle.exit_price, cycle.exit_ts, cycle.pnl = result["status"], result["exit_price"], t, result["pnl"]
            pnl = result["pnl"]
            if pnl >= 0:
                share = bot.compound_pct / 100
                bot.balance += pnl * share
                bot.withdrawn += pnl * (1 - share)
            else:
                left = bot.balance + pnl
                if left < bot.initial_capital * 0.05:      # account wiped: refill like the simulations
                    bot.withdrawn += max(left, 0.0)
                    bot.balance = bot.initial_capital
                    bot.contributed += bot.initial_capital
                else:
                    bot.balance = left
            cycle = None
        bot.last_candle_ts = t
        bot.last_price = candle[4]
    bot.updated_at = datetime.utcnow()


def fetch_closed_1m(symbol: str, since_ts: int) -> list:
    """Closed 1m candles with open time > since_ts (capped to MAX_CATCHUP_MINUTES)."""
    now_open = int(time.time()) // 60 * 60            # current, still-forming candle
    start = max(since_ts + 60, now_open - MAX_CATCHUP_MINUTES * 60)
    if start >= now_open:
        return []
    return market.download_series(symbol, "1m", start, now_open)


def engine_tick(fetch=fetch_closed_1m, zones=bars_5m_since) -> None:
    """One pass over every running bot."""
    db = SessionLocal()
    try:
        bots = db.query(PaperBot).filter(PaperBot.status == "running").all()
        by_symbol: dict[str, list[PaperBot]] = {}
        for b in bots:
            by_symbol.setdefault(b.symbol, []).append(b)
        for symbol, group in by_symbol.items():
            try:
                since = min(b.last_candle_ts for b in group)
                candles = fetch(symbol, since)
                levels = zone_levels(zones(symbol, since)) if any(b.entry_mode == "zone" for b in group) else None
                for b in group:
                    run_bot_on_candles(db, b, candles, levels if b.entry_mode == "zone" else None)
                    b.last_error = None
            except Exception as exc:  # keep the other symbols running
                log.warning("paper engine %s: %s", symbol, exc)
                for b in group:
                    b.last_error = str(exc)[:300]
            db.commit()
    finally:
        db.close()


_engine_started = False


def start_engine() -> None:
    """Start the background loop once per process (disable with PAPER_ENGINE=0, e.g. in tests)."""
    global _engine_started
    import os
    if _engine_started or os.getenv("PAPER_ENGINE", "1") == "0":
        return
    _engine_started = True

    def loop() -> None:
        while True:
            try:
                engine_tick()
            except Exception:
                log.exception("paper engine tick failed")
            time.sleep(POLL_SECONDS)

    threading.Thread(target=loop, name="paper-engine", daemon=True).start()


# ═══════════════════════════════════════════════════════════════════════════
# API
# ═══════════════════════════════════════════════════════════════════════════

router = APIRouter(prefix="/paper", tags=["Paper trading"])


class LadderParams(BaseModel):
    e1Pct: float = Field(3.0, gt=0, le=50)
    e2DistPct: float = Field(1.619, ge=0, le=50)
    liqBufPct: float = Field(1.0, ge=0, le=50)
    tpPct: float = Field(1.0, gt=0, le=100)
    slPct: float = Field(2.618, ge=0, le=100)
    feePct: float = Field(0.06, ge=0, le=1)


class BotCreate(BaseModel):
    name: Optional[str] = Field(None, max_length=80)
    symbol: str
    side: Literal["long", "short"] = "long"
    capital: float = Field(..., gt=0, le=10_000_000)
    leverage: float = Field(..., ge=1, le=125)
    entry_mode: Literal["market", "price", "zone"] = "zone"
    entry_price: Optional[float] = Field(None, gt=0)
    compound_pct: float = Field(0, ge=0, le=100)
    params: LadderParams = LadderParams()

    @field_validator("symbol")
    @classmethod
    def _symbol(cls, v: str) -> str:
        v = v.upper().replace("/", "").replace("-", "")
        if not market.SYMBOL_RE.match(v):
            raise ValueError("Invalid symbol.")
        return v


def _bot_or_404(db: Session, bot_id: int, user: User) -> PaperBot:
    bot = db.query(PaperBot).filter(PaperBot.id == bot_id, PaperBot.user_id == user.id).first()
    if not bot:
        raise HTTPException(status_code=404, detail="Bot not found.")
    return bot


def _cycle_out(c: PaperCycle) -> dict:
    return {"id": c.id, "status": c.status, "capital": round(c.capital, 2), "e1_price": c.e1_price,
            "depth": c.depth, "fills": json.loads(c.fills_json), "entry_ts": c.entry_ts,
            "exit_price": c.exit_price, "exit_ts": c.exit_ts,
            "pnl": None if c.pnl is None else round(c.pnl, 4), "worst_pnl": round(c.worst_pnl, 4)}


def _bot_out(db: Session, bot: PaperBot) -> dict:
    closed = db.query(PaperCycle).filter(PaperCycle.bot_id == bot.id, PaperCycle.status != "open").all()
    open_c = db.query(PaperCycle).filter(PaperCycle.bot_id == bot.id, PaperCycle.status == "open").first()
    realized = sum(c.pnl or 0 for c in closed)
    out = {
        "id": bot.id, "name": bot.name, "symbol": bot.symbol, "side": bot.side, "leverage": bot.leverage,
        "initial_capital": bot.initial_capital, "entry_mode": bot.entry_mode, "entry_price": bot.entry_price,
        "compound_pct": bot.compound_pct, "status": bot.status, "params": bot_params(bot),
        "balance": round(bot.balance, 2), "withdrawn": round(bot.withdrawn, 2), "contributed": round(bot.contributed, 2),
        "cycles": len(closed), "wins": sum(1 for c in closed if c.status == "tp"),
        "losses": sum(1 for c in closed if c.status in ("sl", "liq")),
        "realized_pnl": round(realized, 2), "last_price": bot.last_price,
        "last_candle_ts": bot.last_candle_ts, "last_error": bot.last_error,
        "created_at": bot.created_at.isoformat() + "Z", "open_cycle": None,
    }
    if open_c:
        plan = calc_ladder(open_c.capital, bot.leverage, open_c.e1_price, bot.side, **bot_params(bot))
        k = open_c.depth
        row = plan["rows"][k - 1]
        nxt = plan["rows"][k]["price"] if k < len(plan["rows"]) else None
        oc = _cycle_out(open_c)
        oc.update({"avg": row["avg"], "liq": row["liq"], "tp": row["tp"], "next_entry": nxt,
                   "entries_total": len(plan["rows"]), "margin_used": sum(r["margin"] for r in plan["rows"][:k]),
                   "floating_pnl": None if bot.last_price is None else round(floating_pnl(plan, k, bot.last_price), 4)})
        out["open_cycle"] = oc
    floating = (out["open_cycle"] or {}).get("floating_pnl") or 0.0
    out["net_pnl"] = round(bot.balance + bot.withdrawn - bot.contributed + floating, 2)
    return out


@router.post("/bots", status_code=201)
def create_bot(body: BotCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if body.entry_mode == "price" and not body.entry_price:
        raise HTTPException(status_code=400, detail="entry_price is required when entry_mode is 'price'.")
    plan = calc_ladder(body.capital, body.leverage, 100.0, body.side, **body.params.model_dump())
    if len(plan["rows"]) < 2:
        raise HTTPException(status_code=400, detail="At this leverage E2 would sit beyond liquidation. Lower the leverage.")
    now_open = int(time.time()) // 60 * 60
    bot = PaperBot(user_id=user.id, name=body.name, symbol=body.symbol, side=body.side, leverage=body.leverage,
                   initial_capital=body.capital, params_json=body.params.model_dump_json(),
                   entry_mode=body.entry_mode, entry_price=body.entry_price, compound_pct=body.compound_pct,
                   status="running", balance=body.capital, withdrawn=0.0, contributed=body.capital,
                   last_candle_ts=now_open - 60)
    db.add(bot)
    db.commit()
    db.refresh(bot)
    return _bot_out(db, bot)


@router.get("/bots")
def list_bots(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    bots = db.query(PaperBot).filter(PaperBot.user_id == user.id).order_by(PaperBot.id.desc()).all()
    return {"poll_seconds": POLL_SECONDS, "server_time": int(time.time()), "bots": [_bot_out(db, b) for b in bots]}


@router.get("/bots/{bot_id}/cycles")
def bot_cycles(bot_id: int, limit: int = 50, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    bot = _bot_or_404(db, bot_id, user)
    rows = (db.query(PaperCycle).filter(PaperCycle.bot_id == bot.id)
            .order_by(PaperCycle.id.desc()).limit(max(1, min(limit, 500))).all())
    return [_cycle_out(c) for c in rows]


@router.post("/bots/{bot_id}/stop")
def stop_bot(bot_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    bot = _bot_or_404(db, bot_id, user)
    bot.status = "stopped"
    db.commit()
    return _bot_out(db, bot)


@router.post("/bots/{bot_id}/start")
def resume_bot(bot_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    bot = _bot_or_404(db, bot_id, user)
    if bot.status != "running":
        bot.status = "running"
        bot.last_candle_ts = int(time.time()) // 60 * 60 - 60   # resume from now, skip the paused period
        db.commit()
    return _bot_out(db, bot)


@router.delete("/bots/{bot_id}", status_code=204)
def delete_bot(bot_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    bot = _bot_or_404(db, bot_id, user)
    db.query(PaperCycle).filter(PaperCycle.bot_id == bot.id).delete()
    db.delete(bot)
    db.commit()
