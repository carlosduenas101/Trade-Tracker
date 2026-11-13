"""
Ladder planner and Bitunix entry placement for the Position Hub (phase 2).

Flow (decided with Carlos: "plan, then I confirm")
--------------------------------------------------
1. You open the first entry (E1) yourself, on any exchange.
2. POST /hub/ladders/plan  builds the rest of the ladder from that position with
   one of two presets and returns every price, margin in $, quantity, average,
   liquidation, TP per depth and the SL. Nothing is sent to any exchange.
3. POST /hub/ladders/arm   places the SL/TP and the remaining limit entries, but
   only if ALL of these hold:
     * HUB_TRADING_ENABLED=1 on the server
     * HUB_MAX_LADDER_MARGIN is set and the ladder's total margin is within it
     * the request carries the plan_hash from the plan you just looked at
       (any change in the position or the numbers makes the hash differ)
     * confirm is true
     * the position is a Bitunix API position (KCEX and LBank have no order API:
       their plan is shown so you can place the entries by hand)
4. After every sync the reconcile loop keeps the ladder honest: when an entry
   fills, the TP follows the new average; when the position is gone, every
   remaining entry order is cancelled so a stale order can never open a new trade.

Presets
-------
  dorado : Patron Dorado cascade. Weights 5/10/20/65 of the total ladder margin,
           spacing -1.618% / -3.618% / -4.236% (each measured from the previous
           entry, mirrored for shorts), SL 2.618% beyond the last entry, TP a % of
           the average (default 0.5).
  liq    : Liq Ladder (paper.calc_ladder). total_margin is the ladder capital: E1
           is 3% of it, margins double, E2 at 1.619% from E1, later entries 1%
           before liquidation, SL 2.618% beyond the last entry, TP 1% (E2 closes
           at E1).

Liquidation is the same approximation the calculator uses (average * (1 -/+ 1/L));
Bitunix's real figure includes maintenance margin, so treat it as a guide.

Routes (owner login required)
-----------------------------
  POST /hub/ladders/plan          plan only, no side effects
  POST /hub/ladders/arm           place SL/TP + entries (gated, see above)
  GET  /hub/ladders               ladders with their entries
  POST /hub/ladders/{id}/cancel   cancel the ladder's pending entries
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import time
from datetime import datetime, timedelta
from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal
from typing import Literal, Optional

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import Column, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Session

import paper
from auth import require_pool_owner
from database import Base, User, get_db
from hub import (HTTP_TIMEOUT, BitunixClient, ExchangeError, HubCredential,
                 HubOrder, HubPosition, _f, bitunix_sign, decrypt)

log = logging.getLogger(__name__)

ARMING_TIMEOUT_SECONDS = 120
SYNC_FRESH_SECONDS = 90          # reconcile only acts on data this fresh
QTY_TOLERANCE = 0.005            # 0.5%: an entry counts as filled when the position reached its depth

DORADO = {"weights": [5, 10, 20, 65], "spacing": [1.618, 3.618, 4.236], "sl_pct": 2.618, "tp_pct": 0.5}
LIQ_TP_DEFAULT = 1.0


# ═══════════════════════════════════════════════════════════════════════════
# Tables
# ═══════════════════════════════════════════════════════════════════════════

class HubLadder(Base):
    __tablename__ = "hub_ladders"

    id            = Column(Integer, primary_key=True, autoincrement=True)
    user_id       = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    credential_id = Column(Integer, nullable=False)
    exchange      = Column(String(10), nullable=False)
    device        = Column(String(40), nullable=False)
    symbol        = Column(String(30), nullable=False)
    side          = Column(String(5), nullable=False)
    preset        = Column(String(10), nullable=False)             # dorado | liq
    position_ext_id = Column(String(80), nullable=False)
    status        = Column(String(10), nullable=False, index=True)  # arming | armed | closing | closed | cancelled | failed
    plan_hash     = Column(String(64), nullable=False)
    params_json   = Column(Text, nullable=False)
    sl_price      = Column(Float, nullable=True)
    last_qty      = Column(Float, nullable=False, default=0.0)
    last_error    = Column(String(300), nullable=True)
    created_at    = Column(DateTime, default=datetime.utcnow, nullable=False)
    closed_at     = Column(DateTime, nullable=True)


class HubLadderEntry(Base):
    __tablename__ = "hub_ladder_entries"

    id        = Column(Integer, primary_key=True, autoincrement=True)
    ladder_id = Column(Integer, ForeignKey("hub_ladders.id"), nullable=False, index=True)
    n         = Column(Integer, nullable=False)
    price     = Column(Float, nullable=False)
    qty       = Column(Float, nullable=False)
    cum_qty   = Column(Float, nullable=False)
    margin    = Column(Float, nullable=False)
    client_id = Column(String(40), nullable=False)
    order_id  = Column(String(80), nullable=True)
    status    = Column(String(10), nullable=False, default="placed")   # placed | filled | cancelled | gone | failed
    error     = Column(String(300), nullable=True)


# ═══════════════════════════════════════════════════════════════════════════
# Planning (pure functions, no I/O)
# ═══════════════════════════════════════════════════════════════════════════

def _pos_number_list(name: str, v, lo: int, hi: int) -> list[float]:
    if not isinstance(v, (list, tuple)) or not (lo <= len(v) <= hi):
        raise ValueError(f"{name} must be a list of {lo} to {hi} numbers")
    out = []
    for x in v:
        if isinstance(x, bool) or not isinstance(x, (int, float)) or x <= 0:
            raise ValueError(f"{name} must contain positive numbers")
        out.append(float(x))
    return out


def _liq_of(avg: float, leverage: float, d: int) -> float:
    return avg * (1 - d / leverage)


def _rows_from_entries(side: str, leverage: float, e1_price: float, e1_qty: float,
                       entries: list[tuple[float, float]], tp_for) -> list[dict]:
    """entries = [(price, margin)] for E2..En. Returns rows incl. the real E1."""
    d = 1 if side == "long" else -1
    rows, N, Q = [], 0.0, 0.0
    items = [(e1_price, e1_qty * e1_price / leverage, e1_qty)] + [(p, m, m * leverage / p) for p, m in entries]
    for i, (price, margin, qty) in enumerate(items):
        N += qty * price
        Q += qty
        avg = N / Q
        rows.append({"n": i + 1, "status": "filled" if i == 0 else "planned", "price": price,
                     "margin": margin, "qty": qty, "cum_qty": Q, "avg": avg,
                     "liq": _liq_of(avg, leverage, d), "tp": tp_for(i, avg)})
    return rows


def plan_dorado(side: str, leverage: float, e1_price: float, e1_qty: float, total_margin: float,
                tp_pct: Optional[float] = None, params: Optional[dict] = None) -> dict:
    params = dict(params or {})
    extra = set(params) - {"weights", "spacing", "sl_pct"}
    if extra:
        raise ValueError(f"unknown dorado parameter(s): {sorted(extra)}")
    weights = _pos_number_list("weights", params.get("weights", DORADO["weights"]), 2, 6)
    spacing = _pos_number_list("spacing", params.get("spacing", DORADO["spacing"]), 1, 5)
    if len(spacing) != len(weights) - 1:
        raise ValueError("spacing needs exactly one number fewer than weights")
    sl_pct = float(params.get("sl_pct", DORADO["sl_pct"]))
    tp_pct = float(tp_pct if tp_pct is not None else DORADO["tp_pct"])
    if sl_pct <= 0 or tp_pct <= 0:
        raise ValueError("sl_pct and tp_pct must be positive")
    d = 1 if side == "long" else -1
    total_w = sum(weights)
    prices = [e1_price]
    for s in spacing:                                   # each % measured from the previous entry
        prices.append(prices[-1] * (1 - d * s / 100))
    entries = [(prices[i], total_margin * weights[i] / total_w) for i in range(1, len(weights))]
    rows = _rows_from_entries(side, leverage, e1_price, e1_qty, entries,
                              lambda i, avg: avg * (1 + d * tp_pct / 100))
    planned_e1 = total_margin * weights[0] / total_w
    sl = prices[-1] * (1 - d * sl_pct / 100)
    return {"preset": "dorado", "rows": rows, "sl": sl, "tp_pct": tp_pct,
            "sl_effective": (sl > rows[-1]["liq"]) if d == 1 else (sl < rows[-1]["liq"]),
            "planned_e1_margin": planned_e1,
            "applied": {"weights": weights, "spacing": spacing, "sl_pct": sl_pct, "tp_pct": tp_pct}}


def plan_liq(side: str, leverage: float, e1_price: float, e1_qty: float, capital: float,
             tp_pct: Optional[float] = None, params: Optional[dict] = None) -> dict:
    params = dict(params or {})
    allowed = {"e1Pct", "e2DistPct", "liqBufPct", "slPct", "feePct"}
    if set(params) - allowed:
        raise ValueError(f"unknown liq parameter(s): {sorted(set(params) - allowed)}")
    for k, v in params.items():
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v <= 0:
            raise ValueError(f"{k} must be a positive number")
    tp_pct = float(tp_pct if tp_pct is not None else LIQ_TP_DEFAULT)
    if tp_pct <= 0:
        raise ValueError("tp_pct must be positive")
    lad = paper.calc_ladder(capital, leverage, e1_price, side, tpPct=tp_pct, **params)
    src = lad["rows"]
    if len(src) < 2:
        raise ValueError("this leverage leaves no room for a second entry before liquidation")
    d = 1 if side == "long" else -1
    entries = [(r["price"], r["margin"]) for r in src[1:]]
    tps = [r["tp"] for r in src]
    rows = _rows_from_entries(side, leverage, e1_price, e1_qty, entries, lambda i, avg: tps[i])
    return {"preset": "liq", "rows": rows, "sl": lad["sl"], "tp_pct": tp_pct,
            "sl_effective": bool(lad["sl_effective"]), "planned_e1_margin": src[0]["margin"],
            "applied": {**{k: paper.DEFAULT_PARAMS[k] for k in allowed}, **params, "tp_pct": tp_pct}}


def _quant(precision: int) -> Decimal:
    return Decimal(1).scaleb(-int(precision))


def fmt_decimal(x: Decimal) -> str:
    s = format(x, "f")
    return s.rstrip("0").rstrip(".") if "." in s else s


def round_qty(qty: float, precision: int) -> Decimal:
    return Decimal(str(qty)).quantize(_quant(precision), rounding=ROUND_DOWN)


def round_price(price: float, precision: int) -> Decimal:
    return Decimal(str(price)).quantize(_quant(precision), rounding=ROUND_HALF_UP)


def apply_precision(plan: dict, pair: dict, leverage: float) -> list[str]:
    """Round every planned row to the symbol's precision. Returns blockers."""
    blockers = []
    bp, qp = int(pair["basePrecision"]), int(pair["quotePrecision"])
    min_vol = Decimal(str(pair.get("minTradeVolume") or 0))
    if str(pair.get("symbolStatus", "OPEN")).upper() != "OPEN":
        blockers.append(f"symbol status is {pair.get('symbolStatus')}")
    if pair.get("isApiSupported") is False:
        blockers.append("Bitunix does not allow API trading on this pair")
    for r in plan["rows"]:
        if r["status"] == "filled":
            continue
        q, p = round_qty(r["qty"], bp), round_price(r["price"], qp)
        if q < min_vol or q <= 0:
            blockers.append(f"E{r['n']} quantity {fmt_decimal(q)} is below the minimum {fmt_decimal(min_vol)}")
        r["qty_str"], r["price_str"] = fmt_decimal(q), fmt_decimal(p)
        r["qty"], r["price"] = float(q), float(p)
        r["margin"] = float(q * p) / leverage
    for r in plan["rows"]:
        r["tp"] = float(round_price(r["tp"], qp))
    plan["sl"] = float(round_price(plan["sl"], qp))
    plan["precision"] = {"base": bp, "quote": qp, "min_volume": float(min_vol)}
    # cumulative figures must follow the rounded quantities
    N = Q = 0.0
    d = 1  # liquidation uses the side stored on the plan
    d = 1 if plan["side"] == "long" else -1
    for r in plan["rows"]:
        N += r["qty"] * r["price"]
        Q += r["qty"]
        r["cum_qty"], r["avg"] = Q, N / Q
        r["liq"] = _liq_of(r["avg"], leverage, d)
    return blockers


def plan_hash(plan: dict, position_id: int, pos_qty: float, req_params: dict) -> str:
    entries = [(r["n"], r.get("price_str") or f"{r['price']:.8f}", r.get("qty_str") or f"{r['qty']:.8f}")
               for r in plan["rows"] if r["status"] != "filled"]
    blob = json.dumps({"pid": position_id, "symbol": plan["symbol"], "side": plan["side"],
                       "preset": plan["preset"], "applied": plan["applied"], "req": req_params,
                       "entries": entries, "sl": f"{plan['sl']:.8f}", "pos_qty": f"{pos_qty:.10f}",
                       "tp1": f"{plan['rows'][0]['tp']:.8f}"}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


# ═══════════════════════════════════════════════════════════════════════════
# Bitunix trading client (signed POST)
# ═══════════════════════════════════════════════════════════════════════════

class BitunixTrader(BitunixClient):
    def _post(self, path: str, body: dict) -> dict:
        body_str = json.dumps(body, separators=(",", ":"))     # no spaces: must match what is signed
        nonce, ts = secrets.token_hex(16), str(int(time.time() * 1000))
        headers = {"api-key": self.api_key, "nonce": nonce, "timestamp": ts,
                   "sign": bitunix_sign(nonce, ts, self.api_key, self.secret, {}, body_str),
                   "language": "en-US", "Content-Type": "application/json"}
        r = requests.post(self.BASE + path, data=body_str, headers=headers, timeout=HTTP_TIMEOUT)
        try:
            data = r.json()
        except ValueError:
            raise ExchangeError(f"Bitunix HTTP {r.status_code}: non-JSON response")
        if data.get("code") != 0:
            raise ExchangeError(f"Bitunix error {data.get('code')}: {data.get('msg')}")
        return data

    def pair(self, symbol: str) -> dict:
        r = requests.get(self.BASE + "/api/v1/futures/market/trading_pairs",
                         params={"symbols": symbol}, timeout=HTTP_TIMEOUT)
        data = r.json()
        if data.get("code") != 0:
            raise ExchangeError(f"Bitunix error {data.get('code')}: {data.get('msg')}")
        for p in data.get("data") or []:
            if p.get("symbol") == symbol:
                return p
        raise ExchangeError(f"Bitunix has no pair {symbol}")

    def raw_position(self, symbol: str, position_id: str) -> Optional[dict]:
        rows = self._get("/api/v1/futures/position/get_pending_positions",
                         {"symbol": symbol, "positionId": position_id}).get("data") or []
        return next((p for p in rows if str(p.get("positionId")) == str(position_id)), None)

    def place_limit_entry(self, symbol: str, side: str, qty: str, price: str,
                          client_id: str, hedge: bool) -> str:
        body = {"symbol": symbol, "qty": qty, "side": "BUY" if side == "long" else "SELL",
                "orderType": "LIMIT", "price": price, "effect": "GTC", "clientId": client_id}
        if hedge:
            body["tradeSide"] = "OPEN"
        return str(self._post("/api/v1/futures/trade/place_order", body)["data"]["orderId"])

    def cancel(self, symbol: str, client_ids: list[str]) -> list[dict]:
        data = self._post("/api/v1/futures/trade/cancel_orders",
                          {"symbol": symbol, "orderList": [{"clientId": c} for c in client_ids]}).get("data") or {}
        return data.get("failureList") or []

    def set_position_tpsl(self, symbol: str, position_id: str, tp: Optional[str], sl: Optional[str]) -> None:
        body = {"symbol": symbol, "positionId": str(position_id)}
        if tp:
            body["tpPrice"] = tp
        if sl:
            body["slPrice"] = sl
        try:                                               # a position holds one TP/SL order: create it...
            self._post("/api/v1/futures/tpsl/position/place_order", body)
        except ExchangeError:                              # ...or, if one exists already, modify it
            self._post("/api/v1/futures/tpsl/position/modify_order", body)


def trader_factory(cred: HubCredential) -> BitunixTrader:
    return BitunixTrader(decrypt(cred.api_key_enc), decrypt(cred.api_secret_enc))


# ═══════════════════════════════════════════════════════════════════════════
# Request models and plan assembly
# ═══════════════════════════════════════════════════════════════════════════

class PlanRequest(BaseModel):
    position_id: int
    preset: Literal["dorado", "liq"]
    total_margin: float = Field(gt=0, description="dorado: total margin of the whole ladder in $; liq: ladder capital in $")
    tp_pct: Optional[float] = Field(default=None, gt=0, le=50)
    params: dict = Field(default_factory=dict)


class ArmRequest(PlanRequest):
    plan_hash: str
    confirm: bool = False


def _get_position(db: Session, user: User, position_id: int) -> HubPosition:
    pos = db.query(HubPosition).filter_by(id=position_id, user_id=user.id, status="open").first()
    if not pos:
        raise HTTPException(status_code=404, detail="Open position not found.")
    if not pos.leverage or not pos.avg_entry or not pos.qty:
        raise HTTPException(status_code=400, detail="This position has no entry price, quantity or leverage to plan from.")
    return pos


def _trading_blockers(total_margin: float) -> list[str]:
    out = []
    if os.environ.get("HUB_TRADING_ENABLED", "") != "1":
        out.append("trading is disabled on the server (HUB_TRADING_ENABLED is not 1)")
    cap = _f(os.environ.get("HUB_MAX_LADDER_MARGIN"))
    if cap is None or cap <= 0:
        out.append("HUB_MAX_LADDER_MARGIN is not set")
    elif total_margin > cap + 1e-9:
        out.append(f"ladder margin ${total_margin:,.2f} is above the cap of ${cap:,.2f}")
    return out


def build_plan(db: Session, user: User, req: PlanRequest) -> tuple[dict, HubPosition, Optional[HubCredential]]:
    pos = _get_position(db, user, req.position_id)
    try:
        if req.preset == "dorado":
            plan = plan_dorado(pos.side, pos.leverage, pos.avg_entry, pos.qty, req.total_margin, req.tp_pct, req.params)
        else:
            plan = plan_liq(pos.side, pos.leverage, pos.avg_entry, pos.qty, req.total_margin, req.tp_pct, req.params)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    plan.update({"symbol": pos.symbol, "side": pos.side, "exchange": pos.exchange, "device": pos.device,
                 "leverage": pos.leverage, "position_id": pos.id})
    warnings, blockers = [], []
    actual_e1 = plan["rows"][0]["margin"]
    if abs(actual_e1 - plan["planned_e1_margin"]) > 0.10 * plan["planned_e1_margin"]:
        warnings.append(f"E1 margin is ${actual_e1:,.2f} but this preset expects ${plan['planned_e1_margin']:,.2f}; "
                        "later entries follow the preset, not your E1 size.")
    existing_tp = db.query(HubOrder).filter(HubOrder.user_id == pos.user_id, HubOrder.exchange == pos.exchange,
                                            HubOrder.device == pos.device, HubOrder.symbol == pos.symbol,
                                            HubOrder.tp_price.isnot(None)).first()
    if existing_tp:
        warnings.append(f"An existing take profit at {existing_tp.tp_price} will be replaced by the ladder's TP.")
    if not plan["sl_effective"]:
        warnings.append("The SL sits beyond the estimated liquidation price, so it would not protect the trade.")
    cred = None
    if pos.exchange != "bitunix" or pos.source != "api":
        blockers.append(f"{pos.exchange.upper()} has no order API here: place these entries by hand at the prices shown")
    else:
        cred = db.query(HubCredential).filter_by(id=pos.credential_id, user_id=user.id, active=True).first()
        if not cred:
            blockers.append("the API key for this position is missing or paused")
        else:
            try:
                blockers += apply_precision(plan, trader_factory(cred).pair(pos.symbol), pos.leverage)
            except Exception as exc:
                blockers.append(f"could not read symbol precision: {exc}")
        busy = db.query(HubLadder).filter(HubLadder.user_id == user.id, HubLadder.position_ext_id == pos.external_id,
                                          HubLadder.credential_id == pos.credential_id,
                                          HubLadder.status.in_(("arming", "armed", "closing"))).first()
        if busy:
            blockers.append(f"ladder #{busy.id} is already active on this position")
    total_margin = sum(r["margin"] for r in plan["rows"])
    plan["total_margin"] = total_margin
    if pos.exchange == "bitunix" and pos.source == "api":
        blockers += _trading_blockers(total_margin)
    plan["warnings"], plan["blockers"] = warnings, blockers
    plan["can_arm"] = not blockers
    plan["plan_hash"] = plan_hash(plan, pos.id, pos.qty, {"total_margin": req.total_margin, "tp_pct": req.tp_pct,
                                                          "params": req.params})
    return plan, pos, cred


# ═══════════════════════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════════════════════

router = APIRouter(prefix="/hub/ladders", tags=["Position Hub ladders"])


def _client_id(ladder_id: int, n: int) -> str:
    return f"GMH{ladder_id}E{n}"


@router.post("/plan")
def plan_ladder(req: PlanRequest, db: Session = Depends(get_db), user: User = Depends(require_pool_owner)):
    plan, _, _ = build_plan(db, user, req)
    return plan


@router.post("/arm")
def arm_ladder(req: ArmRequest, db: Session = Depends(get_db), user: User = Depends(require_pool_owner)):
    if not req.confirm:
        raise HTTPException(status_code=400, detail="confirm must be true.")
    plan, pos, cred = build_plan(db, user, req)
    if plan["blockers"]:
        raise HTTPException(status_code=409, detail="Cannot arm: " + "; ".join(plan["blockers"]))
    if req.plan_hash != plan["plan_hash"]:
        raise HTTPException(status_code=409, detail="The plan changed since you reviewed it. Plan again and confirm the new numbers.")
    trader = trader_factory(cred)
    try:
        raw = trader.raw_position(pos.symbol, pos.external_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not re-read the position: {exc}")
    if raw is None or abs(float(raw["qty"]) - pos.qty) > 1e-12 + 1e-9 * pos.qty:
        raise HTTPException(status_code=409, detail="The position changed on the exchange. Plan again.")
    hedge = str(raw.get("positionMode", "")).upper() == "HEDGE"

    lad = HubLadder(user_id=user.id, credential_id=cred.id, exchange="bitunix", device=pos.device, symbol=pos.symbol,
                    side=pos.side, preset=plan["preset"], position_ext_id=pos.external_id, status="arming",
                    plan_hash=plan["plan_hash"], sl_price=plan["sl"], last_qty=pos.qty,
                    params_json=json.dumps({"tp_pct": plan["tp_pct"], "e1_price": pos.avg_entry,
                                            "quote_precision": plan["precision"]["quote"],
                                            "applied": plan["applied"]}))
    db.add(lad)
    db.commit()
    db.refresh(lad)

    placed: list[str] = []
    try:
        trader.set_position_tpsl(pos.symbol, pos.external_id, fmt_decimal(Decimal(str(plan["rows"][0]["tp"]))),
                                 fmt_decimal(Decimal(str(plan["sl"]))))          # SL first: protection before exposure
        for r in plan["rows"]:
            if r["status"] == "filled":
                continue
            cid = _client_id(lad.id, r["n"])
            oid = trader.place_limit_entry(pos.symbol, pos.side, r["qty_str"], r["price_str"], cid, hedge)
            placed.append(cid)
            db.add(HubLadderEntry(ladder_id=lad.id, n=r["n"], price=r["price"], qty=r["qty"], cum_qty=r["cum_qty"],
                                  margin=r["margin"], client_id=cid, order_id=oid, status="placed"))
            db.commit()
    except Exception as exc:
        rollback_note = ""
        if placed:
            try:
                trader.cancel(pos.symbol, placed)
                rollback_note = f" Already-placed entries were cancelled ({len(placed)})."
            except Exception as cexc:
                rollback_note = f" WARNING: could not cancel {len(placed)} placed entries: {cexc}. Check Bitunix."
        db.query(HubLadderEntry).filter(HubLadderEntry.ladder_id == lad.id,
                                        HubLadderEntry.client_id.in_(placed or [""])).update(
            {"status": "cancelled"}, synchronize_session=False)
        lad.status, lad.last_error = "failed", str(exc)[:300]
        db.commit()
        raise HTTPException(status_code=502, detail=f"Arming failed: {exc}.{rollback_note} The SL/TP on the position stays in place.")
    lad.status = "armed"
    db.commit()
    return _ladder_out(db, lad)


def _ladder_out(db: Session, lad: HubLadder) -> dict:
    entries = db.query(HubLadderEntry).filter_by(ladder_id=lad.id).order_by(HubLadderEntry.n).all()
    return {"id": lad.id, "exchange": lad.exchange, "device": lad.device, "symbol": lad.symbol, "side": lad.side,
            "preset": lad.preset, "status": lad.status, "sl_price": lad.sl_price, "last_error": lad.last_error,
            "created_at": lad.created_at.isoformat() + "Z",
            "entries": [{"n": e.n, "price": e.price, "qty": e.qty, "margin": e.margin, "status": e.status,
                         "client_id": e.client_id, "error": e.error} for e in entries]}


@router.get("")
def list_ladders(db: Session = Depends(get_db), user: User = Depends(require_pool_owner)):
    rows = db.query(HubLadder).filter_by(user_id=user.id).order_by(HubLadder.id.desc()).limit(50).all()
    return [_ladder_out(db, r) for r in rows]


@router.post("/{ladder_id}/cancel")
def cancel_ladder(ladder_id: int, db: Session = Depends(get_db), user: User = Depends(require_pool_owner)):
    lad = db.query(HubLadder).filter_by(id=ladder_id, user_id=user.id).first()
    if not lad:
        raise HTTPException(status_code=404, detail="Ladder not found.")
    if lad.status not in ("armed", "arming", "closing"):
        raise HTTPException(status_code=409, detail=f"Ladder is already {lad.status}.")
    cred = db.query(HubCredential).filter_by(id=lad.credential_id, user_id=user.id).first()
    if not cred:
        raise HTTPException(status_code=409, detail="The API key for this ladder no longer exists.")
    _cancel_entries(db, lad, trader_factory(cred))
    lad.status, lad.closed_at = "cancelled", datetime.utcnow()
    db.commit()
    return _ladder_out(db, lad)


def _cancel_entries(db: Session, lad: HubLadder, trader) -> None:
    """Cancel every entry still placed. Raises if the exchange refuses."""
    entries = db.query(HubLadderEntry).filter_by(ladder_id=lad.id, status="placed").all()
    if not entries:
        return
    failures = trader.cancel(lad.symbol, [e.client_id for e in entries])
    failed_ids = {f.get("clientId") for f in failures}
    # "order does not exist" means it already filled or was cancelled: nothing left to cancel
    for e in entries:
        if e.client_id not in failed_ids:
            e.status = "cancelled"
    db.commit()
    still = [f for f in failures if f.get("clientId")]
    if still:
        raise ExchangeError("cancel refused for " + ", ".join(str(f.get("clientId")) for f in still)
                            + ": " + "; ".join(str(f.get("errorMsg")) for f in still))


# ═══════════════════════════════════════════════════════════════════════════
# Reconcile (runs after every sync)
# ═══════════════════════════════════════════════════════════════════════════

def _next_tp(lad: HubLadder, pos: HubPosition, filled_depth: int) -> float:
    meta = json.loads(lad.params_json)
    d = 1 if lad.side == "long" else -1
    if lad.preset == "liq" and filled_depth == 2:           # Liq Ladder: after E2 the TP is E1's price
        tp = meta["e1_price"]
    else:
        tp = pos.avg_entry * (1 + d * meta["tp_pct"] / 100)
    return float(round_price(tp, meta["quote_precision"]))


def reconcile_one(db: Session, lad: HubLadder) -> None:
    cred = db.query(HubCredential).filter_by(id=lad.credential_id).first()
    fresh = (cred is not None and cred.last_error is None and cred.last_sync_at is not None
             and (datetime.utcnow() - cred.last_sync_at).total_seconds() <= SYNC_FRESH_SECONDS)
    if not fresh:
        return                                              # never act on stale or failed data
    trader = trader_factory(cred)

    if lad.status == "arming":
        if (datetime.utcnow() - lad.created_at).total_seconds() < ARMING_TIMEOUT_SECONDS:
            return
        lad.status, lad.last_error = "closing", "arming did not finish; cancelling its entries"

    pos = db.query(HubPosition).filter_by(user_id=lad.user_id, exchange=lad.exchange, device=lad.device,
                                          source="api", external_id=lad.position_ext_id).first()
    if pos is None or pos.status != "open":                 # position gone: no entry order may stay behind
        try:
            _cancel_entries(db, lad, trader)
            lad.status, lad.closed_at, lad.last_error = "closed", datetime.utcnow(), None
        except Exception as exc:
            lad.status, lad.last_error = "closing", str(exc)[:300]
        db.commit()
        return

    pending = {o.client_id for o in db.query(HubOrder).filter_by(
        user_id=lad.user_id, exchange=lad.exchange, device=lad.device, source="api") if o.client_id}
    filled = 0
    for e in db.query(HubLadderEntry).filter_by(ladder_id=lad.id).order_by(HubLadderEntry.n).all():
        if e.status == "placed" and e.client_id not in pending:
            if pos.qty >= e.cum_qty * (1 - QTY_TOLERANCE):
                e.status = "filled"
            else:
                e.status, e.error = "gone", "order left the book without filling (cancelled or rejected)"
        if e.status == "filled":
            filled += 1

    if abs(pos.qty - lad.last_qty) > 1e-12 + 1e-9 * lad.last_qty:      # a fill (or manual add) changed the position
        try:
            tp = _next_tp(lad, pos, 1 + filled)
            trader.set_position_tpsl(lad.symbol, lad.position_ext_id, fmt_decimal(Decimal(str(tp))),
                                     fmt_decimal(Decimal(str(lad.sl_price))) if lad.sl_price else None)
            lad.last_qty, lad.last_error = pos.qty, None
        except Exception as exc:
            lad.last_error = f"TP update failed, will retry: {exc}"[:300]
    db.commit()


def reconcile_all(db: Session) -> None:
    for lad in db.query(HubLadder).filter(HubLadder.status.in_(("arming", "armed", "closing"))).all():
        try:
            reconcile_one(db, lad)
        except Exception as exc:
            db.rollback()
            log.error("ladder %s reconcile failed: %s", lad.id, exc)
