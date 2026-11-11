"""
Tests for backend/paper.py — the live paper trading engine for the Liq Ladder.

* The Python ladder (calc_ladder) must match calcLadder() in frontend/ladder.js.
* A bot fed a long run of synthetic 1m candles must produce exactly the same
  chain of cycles as an independent JavaScript reference built on calcLadder().
* Limit entries (fixed price / zones), catch-up and the HTTP API (auth isolation,
  stop / resume / delete) are checked with fake candle feeds — no network.

Run from the repo root:
    python -m pytest tests/test_paper.py -q
(the cross-checks with ladder.js need Node.js on the PATH; they are skipped otherwise)
"""

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

os.environ.setdefault("PAPER_ENGINE", "0")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

import paper  # noqa: E402
from database import Base, User  # noqa: E402

NODE = shutil.which("node")
needs_node = pytest.mark.skipif(NODE is None, reason="Node.js not installed")
LADDER_JS = str(ROOT / "frontend" / "ladder.js")


# ─── helpers ────────────────────────────────────────────────────────────────

@pytest.fixture()
def db_factory(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(paper, "SessionLocal", factory)
    s = factory()
    s.add_all([User(id=1, username="a", email="a@x.io", hashed_password="x"),
               User(id=2, username="b", email="b@x.io", hashed_password="x")])
    s.commit()
    s.close()
    return factory


def make_candles(n, seed, start=1_767_225_600, p0=100.0, vol=0.0016):
    """Deterministic 1m market with drifts and violent crash / squeeze windows."""
    x = seed
    def rnd():
        nonlocal x
        x = (x * 1103515245 + 12345) % 2147483648
        return x / 2147483648
    out, p = [], p0
    for i in range(n):
        phase = i % 6000
        shock = -0.0035 if 5600 < phase < 5800 else (0.0035 if 2900 < phase < 3050 else 0.0)
        r = (rnd() - 0.5) * vol + shock
        o, c = p, p * (1 + r)
        h = max(o, c) * (1 + rnd() * 0.0008)
        l = min(o, c) * (1 - rnd() * 0.0008)
        out.append([start + i * 60, o, h, l, c])
        p = c
    return out


def new_bot(db, **kw):
    cfg = dict(user_id=1, symbol="BTCUSDT", side="long", leverage=5.0, initial_capital=1000.0,
               params_json=json.dumps(paper.DEFAULT_PARAMS), entry_mode="market", entry_price=None,
               compound_pct=0.0, status="running", balance=1000.0, withdrawn=0.0, contributed=1000.0,
               last_candle_ts=0)
    cfg.update(kw)
    cfg["balance"] = cfg["contributed"] = cfg["initial_capital"]
    bot = paper.PaperBot(**cfg)
    db.add(bot)
    db.commit()
    return bot


def run_node(script, payload):
    r = subprocess.run([NODE, "-e", script], input=json.dumps(payload), capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


# ─── 1. ladder plan parity with ladder.js ───────────────────────────────────

JS_PLAN = """
const { calcLadder } = require(%s);
const cfgs = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(JSON.stringify(cfgs.map(c => { const p = calcLadder(c);
  return { rows: p.rows.map(r => [r.margin, r.price, r.avg, r.liq, r.tp, r.profit]),
           sl: p.sl, slEffective: p.slEffective, slLoss: p.slLoss, liqLoss: p.liqLoss }; })));
""" % json.dumps(LADDER_JS)


@needs_node
def test_calc_ladder_matches_ladder_js():
    cfgs = []
    for lev in (2, 3, 5, 7, 10):
        for side in ("long", "short"):
            for extra in ({}, {"e1Pct": 5, "e2DistPct": 2.5, "liqBufPct": 0.5, "tpPct": 2, "slPct": 1, "feePct": 0.1}):
                cfgs.append({"capital": 1000, "leverage": lev, "e1Price": 104321.5, "side": side, **extra})
    js = run_node(JS_PLAN, cfgs)
    for cfg, ref in zip(cfgs, js):
        py = paper.calc_ladder(cfg["capital"], cfg["leverage"], cfg["e1Price"], cfg["side"],
                               **{k: v for k, v in cfg.items() if k not in ("capital", "leverage", "e1Price", "side")})
        assert len(py["rows"]) == len(ref["rows"]), cfg
        for a, b in zip(py["rows"], ref["rows"]):
            assert [a["margin"], a["price"], a["avg"], a["liq"], a["tp"], a["profit"]] == pytest.approx(b, rel=1e-12)
        assert py["sl"] == pytest.approx(ref["sl"], rel=1e-12)
        assert py["sl_effective"] == ref["slEffective"]
        assert py["sl_loss"] == pytest.approx(ref["slLoss"], rel=1e-12)
        assert py["liq_loss"] == pytest.approx(ref["liqLoss"], rel=1e-12)


# ─── 2. chained cycles vs an independent JS reference ───────────────────────

JS_CHAIN = """
const { calcLadder } = require(%s);
const { cfg, candles } = JSON.parse(require('fs').readFileSync(0, 'utf8'));
// Independent reference: market E1 at the open of the candle after each exit,
// absolute price levels from calcLadder, order fills -> SL -> liq -> TP.
let balance = cfg.capital, withdrawn = 0, contributed = cfg.capital;
const cycles = [];
let i = 0;
while (i < candles.length) {
  const plan = calcLadder({ ...cfg.params, capital: balance, leverage: cfg.leverage, e1Price: candles[i][1], side: cfg.side });
  const long = cfg.side === 'long';
  let k = 1, res = null, j = i;
  for (; j < candles.length; j++) {
    const [, , hi, lo] = candles[j];
    const hitE = p => long ? lo <= p : hi >= p, hitTp = p => long ? hi >= p : lo <= p;
    while (k < plan.rows.length && hitE(plan.rows[k].price)) k++;
    if (plan.slEffective && k === plan.rows.length && hitE(plan.sl)) { res = ['sl', plan.slLoss]; break; }
    if (hitE(plan.rows[k - 1].liq)) { res = ['liq', plan.liqLoss]; break; }
    if (j > i && hitTp(plan.rows[k - 1].tp)) { res = ['tp', plan.rows[k - 1].profit]; break; }
  }
  if (!res) { cycles.push([candles[i][0], 'open', k, null]); break; }
  cycles.push([candles[i][0], res[0], k, res[1]]);
  const pnl = res[1];
  if (pnl >= 0) { balance += pnl * cfg.compound / 100; withdrawn += pnl * (1 - cfg.compound / 100); }
  else { const left = balance + pnl;
         if (left < cfg.capital * 0.05) { withdrawn += Math.max(left, 0); balance = cfg.capital; contributed += cfg.capital; }
         else balance = left; }
  i = j + 1;
}
console.log(JSON.stringify({ cycles, balance, withdrawn, contributed }));
""" % json.dumps(LADDER_JS)


@needs_node
@pytest.mark.parametrize("side,lev,compound", [("long", 3, 0), ("long", 5, 50), ("long", 7, 100),
                                                ("short", 5, 0), ("short", 7, 100)])
def test_engine_matches_independent_js_chain(db_factory, side, lev, compound):
    candles = make_candles(30_000, seed=7 + lev)
    db = db_factory()
    bot = new_bot(db, side=side, leverage=float(lev), compound_pct=float(compound))
    # Feed the candles in uneven batches, like the live poller (with repeats)
    pos = 0
    for size in [1, 5, 60, 600, 3, 2000] * 100:
        if pos >= len(candles):
            break
        batch = candles[max(0, pos - 2):pos + size]          # overlap: already-processed candles are skipped
        paper.run_bot_on_candles(db, bot, batch)
        db.commit()
        pos += size

    ref = run_node(JS_CHAIN, {"cfg": {"capital": 1000, "leverage": lev, "side": side, "compound": compound,
                                      "params": paper.DEFAULT_PARAMS}, "candles": candles})
    got = db.query(paper.PaperCycle).filter_by(bot_id=bot.id).order_by(paper.PaperCycle.id).all()
    assert len(got) == len(ref["cycles"]) and len(got) > 20
    statuses = set()
    for c, (ts, st, k, pnl) in zip(got, ref["cycles"]):
        assert (c.entry_ts, c.status, c.depth) == (ts, st, k)
        if pnl is not None:
            assert c.pnl == pytest.approx(pnl, rel=1e-9, abs=1e-9)
        statuses.add(st)
    assert "tp" in statuses
    if lev >= 5:
        assert statuses & {"sl", "liq"}, "the synthetic crashes must exercise losses too"
    assert bot.balance == pytest.approx(ref["balance"], rel=1e-9)
    assert bot.withdrawn == pytest.approx(ref["withdrawn"], rel=1e-9)
    assert bot.contributed == pytest.approx(ref["contributed"], rel=1e-9)
    assert bot.last_candle_ts == candles[-1][0]


# ─── 3. entries ─────────────────────────────────────────────────────────────

def test_limit_entry_fills_at_the_limit_or_better():
    # long limit at 100
    assert paper.entry_fill("price", "long", [0, 101, 102, 100.5, 101], 100) is None
    assert paper.entry_fill("price", "long", [0, 101, 102, 99.0, 101], 100) == 100          # touched → limit price
    assert paper.entry_fill("price", "long", [0, 98, 99, 97, 98], 100) == 98                # already below → open
    # short limit at 100
    assert paper.entry_fill("price", "short", [0, 99, 99.5, 98, 99], 100) is None
    assert paper.entry_fill("price", "short", [0, 99, 100.2, 98, 99], 100) == 100
    assert paper.entry_fill("market", "short", [0, 99, 100.2, 98, 99], None) == 99


def test_price_mode_waits_for_the_level_and_tp_not_on_entry_candle(db_factory):
    db = db_factory()
    bot = new_bot(db, entry_mode="price", entry_price=100.0, leverage=3.0)
    t0 = 1_767_225_600
    candles = [[t0, 103, 103.5, 102, 102.5],           # above the level: no entry
               [t0 + 60, 102.5, 102.6, 99.8, 101.2],   # touches 100 → E1 @ 100 (high 102.6 ≥ TP 101 ignored)
               [t0 + 120, 101.2, 101.3, 100.9, 101.0]] # TP 101 hit on the next candle
    paper.run_bot_on_candles(db, bot, candles)
    db.commit()
    cyc = db.query(paper.PaperCycle).filter_by(bot_id=bot.id).all()
    assert len(cyc) == 1 and cyc[0].e1_price == 100 and cyc[0].entry_ts == t0 + 60
    assert cyc[0].status == "tp" and cyc[0].exit_ts == t0 + 120 and cyc[0].exit_price == pytest.approx(101)
    plan = paper.calc_ladder(1000, 3, 100, "long")
    assert cyc[0].pnl == pytest.approx(plan["rows"][0]["profit"])
    assert bot.withdrawn == pytest.approx(plan["rows"][0]["profit"]) and bot.balance == 1000


def test_zone_levels_and_targets():
    # 5m bars: rally 100 → 200 then a pull-back, so a swing top and bottom exist
    bars, t = [], 1_767_225_600
    path = [100 + i for i in range(101)] + [200 - i * 0.5 for i in range(1, 121)] + [140 + i * 0.1 for i in range(80)]
    for i, p in enumerate(path):
        bars.append([t + i * 300, p, p + 0.2, p - 0.2, p])
    levels = paper.zone_levels(bars, length=10)
    assert levels, "a swing range must be found"
    ts, top, bot, close = levels[-1]
    assert ts == bars[-1][0] + 300 and top > bot
    eq, dz = bot + 0.525 * (top - bot), bot + 0.05 * (top - bot)
    tgt = paper.zone_target(levels, ts, "long")
    assert tgt == pytest.approx(eq if close > eq else dz if close > dz else close)
    assert paper.zone_target(levels, levels[0][0] - 1, "long") is None, "no 5m bar closed yet → no order"
    # a 1m candle uses the last 5m bar closed at or before its open
    mid = levels[len(levels) // 2]
    assert paper.zone_target(levels, mid[0] + 120, "short") == paper.zone_target(levels, mid[0], "short")


# ─── 4. engine tick: catch-up, errors, isolation per symbol ─────────────────

def test_engine_tick_catches_up_and_reports_errors(db_factory):
    db = db_factory()
    t0 = 1_767_225_600
    good = new_bot(db, symbol="BTCUSDT", last_candle_ts=t0 - 60)
    bad = new_bot(db, symbol="NOPEUSDT", last_candle_ts=t0 - 60)
    stopped = new_bot(db, symbol="BTCUSDT", status="stopped", last_candle_ts=t0 - 60)
    candles = make_candles(500, seed=3, start=t0)
    asked = []

    def fetch(symbol, since):
        asked.append((symbol, since))
        if symbol == "NOPEUSDT":
            raise RuntimeError("this Futures is not allowed to trade.")
        return [c for c in candles if c[0] > since]

    paper.engine_tick(fetch=fetch, zones=lambda s, since: [])
    db.expire_all()
    assert ("BTCUSDT", t0 - 60) in asked
    g, b, s = (db.get(paper.PaperBot, x.id) for x in (good, bad, stopped))
    assert g.last_candle_ts == candles[-1][0] and g.last_error is None
    assert b.last_error == "this Futures is not allowed to trade." and b.last_candle_ts == t0 - 60
    assert s.last_candle_ts == t0 - 60, "stopped bots are not advanced"
    n = db.query(paper.PaperCycle).filter_by(bot_id=g.id).count()
    assert n >= 1
    paper.engine_tick(fetch=fetch, zones=lambda s, since: [])      # nothing new → nothing changes
    assert db.query(paper.PaperCycle).filter_by(bot_id=g.id).count() == n


def test_fetch_closed_1m_caps_catch_up(monkeypatch):
    seen = {}
    def fake_download(symbol, interval, start, end):
        seen.update(symbol=symbol, interval=interval, start=start, end=end)
        return []
    monkeypatch.setattr(paper.market, "download_series", fake_download)
    now_open = int(time.time()) // 60 * 60
    paper.fetch_closed_1m("BTCUSDT", 0)
    assert seen["interval"] == "1m" and seen["end"] == now_open
    assert seen["start"] == now_open - paper.MAX_CATCHUP_MINUTES * 60
    seen.clear()
    assert paper.fetch_closed_1m("BTCUSDT", now_open - 60) == [] and not seen, "nothing closed yet → no request"
    assert paper.market.INTERVAL_SECONDS["1m"] == 60


# ─── 5. HTTP API ────────────────────────────────────────────────────────────

def test_api_flow_and_user_isolation(db_factory):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(paper.router)
    current = {"id": 1}

    def get_db():
        db = db_factory()
        try:
            yield db
        finally:
            db.close()

    def get_user():
        db = db_factory()
        try:
            return db.get(User, current["id"])
        finally:
            db.close()

    app.dependency_overrides[paper.get_db] = get_db
    app.dependency_overrides[paper.get_current_user] = get_user
    client = TestClient(app)

    bad = [{"symbol": "BTC;DROP", "capital": 1000, "leverage": 5},
           {"symbol": "BTCUSDT", "capital": 0, "leverage": 5},
           {"symbol": "BTCUSDT", "capital": 1000, "leverage": 5, "entry_mode": "price"},
           {"symbol": "BTCUSDT", "capital": 1000, "leverage": 100}]          # E2 (-1.619%) beyond liquidation (-1%)
    for body in bad:
        assert client.post("/paper/bots", json=body).status_code in (400, 422), body

    r = client.post("/paper/bots", json={"name": "BTC 5x", "symbol": "btc/usdt", "side": "long", "capital": 1000,
                                         "leverage": 5, "entry_mode": "market", "compound_pct": 50})
    assert r.status_code == 201, r.text
    bot = r.json()
    assert bot["symbol"] == "BTCUSDT" and bot["status"] == "running" and bot["net_pnl"] == 0
    assert bot["params"]["e2DistPct"] == 1.619 and bot["open_cycle"] is None

    # Feed candles through the engine with a fake feed
    t0 = bot["last_candle_ts"] + 60
    candles = make_candles(3000, seed=11, start=t0)
    paper.engine_tick(fetch=lambda s, since: [c for c in candles if c[0] > since], zones=lambda s, since: [])

    body = client.get("/paper/bots").json()
    assert body["poll_seconds"] == paper.POLL_SECONDS and len(body["bots"]) == 1
    b = body["bots"][0]
    assert b["last_candle_ts"] == candles[-1][0] and b["last_price"] == candles[-1][4]
    assert b["cycles"] == b["wins"] + b["losses"]
    oc = b["open_cycle"]
    floating = oc["floating_pnl"] if oc else 0
    assert b["net_pnl"] == pytest.approx(b["balance"] + b["withdrawn"] - b["contributed"] + floating, abs=0.02)
    if oc:
        assert oc["status"] == "open" and oc["avg"] > 0 and oc["liq"] < oc["avg"] and oc["tp"] > 0
        assert oc["floating_pnl"] is not None and 1 <= oc["depth"] <= oc["entries_total"]

    cycles = client.get(f"/paper/bots/{b['id']}/cycles", params={"limit": 500}).json()
    assert len(cycles) == b["cycles"] + (1 if oc else 0)
    assert sum(c["pnl"] for c in cycles if c["status"] != "open") == pytest.approx(b["realized_pnl"], abs=0.05)

    # Another user cannot see or touch the bot
    current["id"] = 2
    assert client.get("/paper/bots").json()["bots"] == []
    for method, url in [("get", f"/paper/bots/{b['id']}/cycles"), ("post", f"/paper/bots/{b['id']}/stop"),
                        ("post", f"/paper/bots/{b['id']}/start"), ("delete", f"/paper/bots/{b['id']}")]:
        assert getattr(client, method)(url).status_code == 404
    current["id"] = 1

    # Stop → the engine leaves it alone; resume skips the paused period
    assert client.post(f"/paper/bots/{b['id']}/stop").json()["status"] == "stopped"
    more = make_candles(100, seed=12, start=candles[-1][0] + 60)
    paper.engine_tick(fetch=lambda s, since: [c for c in more if c[0] > since], zones=lambda s, since: [])
    assert client.get("/paper/bots").json()["bots"][0]["last_candle_ts"] == candles[-1][0]
    resumed = client.post(f"/paper/bots/{b['id']}/start").json()
    assert resumed["status"] == "running" and resumed["last_candle_ts"] == int(time.time()) // 60 * 60 - 60

    assert client.delete(f"/paper/bots/{b['id']}").status_code == 204
    assert client.get("/paper/bots").json()["bots"] == []
    db = db_factory()
    assert db.query(paper.PaperCycle).count() == 0


def test_main_registers_paper_routes_before_catch_all(tmp_path):
    os.environ.setdefault("DATABASE_URL", f"sqlite:///{tmp_path / 't.db'}")
    from fastapi.testclient import TestClient
    import main
    r = TestClient(main.app).get("/paper/bots")
    assert r.status_code in (401, 403), "auth required → handled by the paper router, not index.html"
