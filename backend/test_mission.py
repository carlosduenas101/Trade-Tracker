"""
Mission Control tests, run with:  venv/Scripts/python backend/test_mission.py

Same setup as test_hub.py: a TEMPORARY sqlite database (DATABASE_URL is forced
before anything is imported) and a mini FastAPI app with only the hub and
mission routers. Nothing touches the real database or any exchange.

Every expected number below is worked out by hand in the comment next to it.
"""

import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

TMP = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{(Path(TMP) / 'mission_test.db').as_posix()}"
os.environ["POOL_OWNER_USER_ID"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI                                  # noqa: E402
from fastapi.testclient import TestClient                    # noqa: E402

import hub                                                   # noqa: E402
import hub_ladder                                            # noqa: E402
import mission                                               # noqa: E402
from auth import require_pool_owner                          # noqa: E402
from database import Base, SessionLocal, User, engine        # noqa: E402

Base.metadata.create_all(bind=engine)

app = FastAPI()
app.include_router(hub.router)
app.include_router(mission.router)
app.dependency_overrides[require_pool_owner] = lambda: User(id=1)
client = TestClient(app)

guarded = FastAPI()           # no override: the real owner guard
guarded.include_router(mission.router)
anon = TestClient(guarded)

PASSED = []


def check(name, cond, extra=""):
    if not cond:
        print(f"FAIL  {name} {extra}")
        sys.exit(1)
    PASSED.append(name)
    print(f"ok    {name}")


def near(a, b, tol=1e-6):
    return a is not None and abs(a - b) <= tol


def pos(ext, symbol, side, qty, avg, upnl, margin, lev, liq):
    return {"external_id": ext, "symbol": symbol, "side": side, "qty": qty, "avg_entry": avg,
            "unrealized_pnl": upnl, "margin": margin, "leverage": lev, "liq_price": liq,
            "margin_mode": "isolated"}


def summary():
    r = client.get("/mission/summary")
    assert r.status_code == 200, r.text
    return r.json()


def by_name(s, name):
    return next(a for a in s["accounts"] if a["name"] == name)


# ── 1. Pure math ───────────────────────────────────────────────────────────
# long: mark = 90000 + (-30 / 0.01) = 87000
check("mark long", near(mission.mark_estimate("long", 90000, 0.01, -30), 87000))
# short: mark = 3000 - (-150 / 1) = 3150
check("mark short", near(mission.mark_estimate("short", 3000, 1, -150), 3150))
check("mark needs qty/avg/upnl", mission.mark_estimate("long", 90000, 0, -30) is None
      and mission.mark_estimate("long", None, 1, 5) is None
      and mission.mark_estimate("long", 90000, 1, None) is None)
# long liq distance: (87000 - 61000) / 87000 = 29.885057...%
check("liq distance long", near(mission.liq_distance_pct("long", 87000, 61000), 26000 / 87000 * 100))
# short liq distance: (3300 - 3150) / 3150 = 4.761905%
check("liq distance short", near(mission.liq_distance_pct("short", 3150, 3300), 150 / 3150 * 100))
check("liq distance missing liq", mission.liq_distance_pct("long", 87000, None) is None)
check("risk bands", mission.risk_band(4.99) == "danger" and mission.risk_band(5.0) == "warn"
      and mission.risk_band(14.99) == "warn" and mission.risk_band(15.0) == "ok"
      and mission.risk_band(None) == "unknown")
check("roe", near(mission.roe_pct(-30, 300), -10.0) and mission.roe_pct(5, 0) is None)
check("base asset", mission.base_asset("BTC_USDT") == "BTC" and mission.base_asset("ETHUSDT") == "ETH"
      and mission.base_asset("XAUTUSDT") == "XAUT" and mission.base_asset("btc/usdc") == "BTC")

# ── 2. Accounts: defaults, save, validation ────────────────────────────────
r = client.get("/mission/accounts").json()
check("default accounts", not r["saved"] and [a["name"] for a in r["accounts"]]
      == ["KCEX Main", "KCEX 2", "Bitunix", "LBank"])
bad = client.put("/mission/accounts", json={"accounts": [{"name": "A", "exchange": "kcex"},
                                                          {"name": "a", "exchange": "lbank"}]})
check("duplicate names rejected", bad.status_code == 422)
bad = client.put("/mission/accounts", json={"accounts": [{"name": "A", "exchange": "binance"}]})
check("unknown exchange rejected", bad.status_code == 422)
r = client.put("/mission/accounts", json={"accounts": [{"name": "Bitunix", "exchange": "bitunix"},
                                                        {"name": "KCEX Main", "exchange": "kcex"}]}).json()
check("save keeps order", r["saved"] and [a["name"] for a in r["accounts"]] == ["Bitunix", "KCEX Main"])
r = client.put("/mission/accounts", json={"accounts": mission.DEFAULT_ACCOUNTS}).json()
check("save the four accounts", [a["name"] for a in r["accounts"]] == ["KCEX Main", "KCEX 2", "Bitunix", "LBank"])

check("owner guard", anon.get("/mission/summary").status_code in (401, 403))

# ── 3. Empty state ─────────────────────────────────────────────────────────
s = summary()
check("empty totals", s["totals"]["open"] == 0 and s["totals"]["margin"] == 0 and s["positions"] == [])
check("all accounts no feed", all(a["feed"]["status"] == "no_feed" for a in s["accounts"]))
check("bitunix expects api, kcex expects reader",
      by_name(s, "Bitunix")["feed"]["via"] == "api" and by_name(s, "KCEX 2")["feed"]["via"] == "browser")

# ── 4. Live data on three accounts ─────────────────────────────────────────
db = SessionLocal()
db.add(hub.HubCredential(user_id=1, exchange="bitunix", device="Bitunix", api_key_enc="x",
                         api_secret_enc="x", key_hint="abcd…wxyz", active=True))
db.commit()
cred = db.query(hub.HubCredential).first()

hub.apply_state(db, user_id=1, exchange="kcex", device="KCEX Main", source="browser", credential_id=None,
                positions=[pos("BTCUSDT:long", "BTCUSDT", "long", 0.01, 90000, -30, 300, 3, 61000)],
                orders=[])
hub.apply_state(db, user_id=1, exchange="kcex", device="KCEX 2", source="browser", credential_id=None,
                positions=[pos("BTCUSDT:long", "BTCUSDT", "long", 0.02, 88000, 40, 352, 5, 80000)],
                orders=[])
hub.apply_state(db, user_id=1, exchange="bitunix", device="Bitunix", source="api", credential_id=cred.id,
                positions=[pos("777", "ETHUSDT", "short", 1, 3000, -150, 600, 5, 3300)],
                orders=[{"order_id": "o1", "symbol": "ETHUSDT", "side": "sell", "kind": "entry",
                         "price": 3200, "qty": 2},
                        {"order_id": "o2", "symbol": "ETHUSDT", "side": "sell", "kind": "entry",
                         "price": 3400, "qty": 4}])

# Armed ladder on the Bitunix ETH short: 5 placed entries, 2 filled -> E3 of 6
lad = hub_ladder.HubLadder(user_id=1, credential_id=cred.id, exchange="bitunix", device="Bitunix",
                           symbol="ETHUSDT", side="short", preset="liq", position_ext_id="777",
                           status="armed", plan_hash="h", params_json="{}")
db.add(lad)
db.commit()
for n, st in zip(range(2, 7), ["filled", "filled", "placed", "placed", "placed"]):
    db.add(hub_ladder.HubLadderEntry(ladder_id=lad.id, n=n, price=3000 + n, qty=1, cum_qty=n, margin=1,
                                     client_id=f"c{n}", status=st))
db.commit()

s = summary()
P = {(p["account"], p["symbol"]): p for p in s["positions"]}
btc1, btc2, eth = P[("KCEX Main", "BTCUSDT")], P[("KCEX 2", "BTCUSDT")], P[("Bitunix", "ETHUSDT")]

check("KCEX Main mark/liq/roe", near(btc1["mark_est"], 87000) and near(btc1["liq_distance_pct"], 26000 / 87000 * 100)
      and btc1["risk"] == "ok" and near(btc1["roe_pct"], -10.0) and near(btc1["notional"], 870))
# KCEX 2: mark = 88000 + 40/0.02 = 90000; dist = 10000/90000 = 11.111%; roe = 40/352 = 11.3636%
check("KCEX 2 mark/liq/roe", near(btc2["mark_est"], 90000) and near(btc2["liq_distance_pct"], 100 / 9)
      and btc2["risk"] == "warn" and near(btc2["roe_pct"], 40 / 352 * 100) and near(btc2["notional"], 1800))
# Bitunix: mark 3150, dist 4.7619% danger, roe -25%, next entry 3200: |3150-3200|/3150 = 1.5873%
check("Bitunix mark/liq/roe", near(eth["mark_est"], 3150) and near(eth["liq_distance_pct"], 150 / 3150 * 100)
      and eth["risk"] == "danger" and near(eth["roe_pct"], -25.0) and near(eth["notional"], 3150))
check("next entry is the nearest", eth["next_entry"]["price"] == 3200
      and near(eth["next_entry"]["distance_pct"], 50 / 3150 * 100))
check("ladder progress E3/6", eth["ladder"] == {"filled": 3, "total": 6, "preset": "liq", "status": "armed"})
check("no ladder -> none", btc1["ladder"] is None and btc1["next_entry"] is None)

t = s["totals"]
# margin 300+352+600 = 1252; upnl -30+40-150 = -140; roe -140/1252 = -11.18211%; notional 870+1800+3150 = 5820
check("totals", t["open"] == 3 and near(t["margin"], 1252) and near(t["upnl"], -140)
      and near(t["roe_pct"], -140 / 1252 * 100) and near(t["notional"], 5820)
      and t["longs"] == 2 and t["shorts"] == 1 and t["at_risk"] == 2)
check("closest to liq is ETH", t["closest"]["symbol"] == "ETHUSDT" and t["closest"]["account"] == "Bitunix"
      and t["closest"]["risk"] == "danger")

A = {a["asset"]: a for a in s["assets"]}
# BTC: 2 trades, margin 652, upnl +10, notional 2670, closest = KCEX 2 at 11.111%
check("by asset BTC", A["BTC"]["open"] == 2 and near(A["BTC"]["margin"], 652) and near(A["BTC"]["upnl"], 10)
      and near(A["BTC"]["notional"], 2670) and A["BTC"]["accounts"] == ["KCEX 2", "KCEX Main"]
      and near(A["BTC"]["closest"]["liq_distance_pct"], 100 / 9))
check("assets sorted by margin", [a["asset"] for a in s["assets"]] == ["BTC", "ETH"])

check("account totals", by_name(s, "KCEX 2")["open"] == 1 and near(by_name(s, "KCEX 2")["margin"], 352)
      and near(by_name(s, "Bitunix")["upnl"], -150))
check("feeds live", all(by_name(s, n)["feed"]["status"] == "live" for n in ("KCEX Main", "KCEX 2", "Bitunix")))
check("LBank still no feed", by_name(s, "LBank")["feed"]["status"] == "no_feed" and by_name(s, "LBank")["open"] == 0)
check("account order kept", [a["name"] for a in s["accounts"]] == ["KCEX Main", "KCEX 2", "Bitunix", "LBank"])

# ── 5. Stale, error, flat and unlisted ─────────────────────────────────────
old = datetime.utcnow() - timedelta(seconds=400)          # > 180 s browser limit
two_min = datetime.utcnow() - timedelta(seconds=120)      # > 60 s api limit
# A feed that stops stops refreshing its positions too, so age both
db.query(hub.HubFeed).filter_by(device="KCEX 2").update({"last_at": old})
db.query(hub.HubPosition).filter_by(device="KCEX 2").update({"last_seen_at": old})
db.query(hub.HubFeed).filter_by(device="Bitunix").update({"last_at": two_min})
db.query(hub.HubPosition).filter_by(device="Bitunix").update({"last_seen_at": two_min})
cred.last_error = "ExchangeError: Bitunix error 10003: bad sign"
db.commit()
s = summary()
check("KCEX 2 stale", by_name(s, "KCEX 2")["feed"]["status"] == "stale")
check("Bitunix error shown", by_name(s, "Bitunix")["feed"]["status"] == "error"
      and "10003" in by_name(s, "Bitunix")["feed"]["error"])
check("positions kept while a feed is stale", s["totals"]["open"] == 3)

# KCEX Main reports zero positions: trade closed, feed still live (flat, not disconnected)
hub.apply_state(db, user_id=1, exchange="kcex", device="KCEX Main", source="browser", credential_id=None,
                positions=[], orders=[])
s = summary()
check("flat account stays live", by_name(s, "KCEX Main")["feed"]["status"] == "live"
      and by_name(s, "KCEX Main")["open"] == 0 and s["totals"]["open"] == 2)

# Data from a name that is not in the list still shows, flagged
hub.apply_state(db, user_id=1, exchange="lbank", device="PC-1", source="browser", credential_id=None,
                positions=[pos("XRPUSDT:long", "XRPUSDT", "long", 100, 2.0, 5, 40, 5, 1.6)], orders=[])
s = summary()
un = by_name(s, "PC-1")
check("unlisted account shown", un["unlisted"] and un["exchange"] == "lbank" and un["open"] == 1)
check("LBank (listed) still no feed", by_name(s, "LBank")["feed"]["status"] == "no_feed")

# Paused key
cred.active = False
db.commit()
check("paused flag", summary()["accounts"][2]["feed"]["paused"] is True)
db.close()

# Old ingest code (no hub_feeds row): a fresh position still counts as a heartbeat
db = SessionLocal()
db.add(hub.HubPosition(user_id=1, exchange="kcex", device="Legacy", source="browser", external_id="SOLUSDT:long",
                       symbol="SOLUSDT", side="long", qty=1, avg_entry=150, margin=30, unrealized_pnl=0,
                       status="open", last_seen_at=datetime.utcnow()))
db.commit()
db.close()
lg = by_name(summary(), "Legacy")
check("position counts as heartbeat", lg["feed"]["status"] == "live" and lg["feed"]["via"] == "browser")

# Leftover feed under an old name: shown while recent, hidden after an hour of silence
db = SessionLocal()
hub.apply_state(db, user_id=1, exchange="bitunix", device="Main Phone", source="api", credential_id=None,
                positions=[], orders=[])
check("recent leftover shown", any(a["name"] == "Main Phone" for a in summary()["accounts"]))
db.query(hub.HubFeed).filter_by(device="Main Phone").update(
    {"last_at": datetime.utcnow() - timedelta(seconds=mission.UNLISTED_FEED_MAX_AGE + 60)})
db.commit()
db.close()
check("old leftover hidden", not any(a["name"] == "Main Phone" for a in summary()["accounts"]))
check("listed account with old feed still shown", any(a["name"] == "KCEX 2" for a in summary()["accounts"]))

# ── 6. Trades entered by hand ─────────────────────────────────────────────
PRICES = {"BTCUSDT": 57000.0}
mission.live_price = lambda sym: PRICES.get(mission.norm_symbol(sym))
base = {"account": "Old Phone", "exchange": "kcex", "symbol": "BTC/USDT", "side": "long",
        "leverage": 5, "avg_entry": 60000, "margin": 20, "tp_price": 61000}
r = client.post("/mission/manual", json=base)
check("manual add", r.status_code == 201, r.text)
mid = r.json()["id"]
s = summary()
mp = next(p for p in s["positions"] if p["id"] == mid)
# qty = 20 x 5 / 60000 = 0.0016667; uPnL = (57000-60000) x qty = -5.00; ROE = -25%
check("manual qty/upnl/roe", near(mp["qty"], 100 / 60000) and near(mp["unrealized_pnl"], -5.0)
      and near(mp["roe_pct"], -25.0) and mp["manual"] and not mp["stale"] and mp["symbol"] == "BTCUSDT")
# no liq given: est. 60000 x (1 - 1/5) = 48000; distance (57000-48000)/57000 = 15.789% -> ok
check("manual liq estimated", near(mp["liq_price"], 48000) and mp["liq_estimated"]
      and near(mp["liq_distance_pct"], 9000 / 57000 * 100) and mp["risk"] == "ok")
check("manual tp shown", mp["tp_price"] == 61000 and mp["sl_price"] is None)
acc = by_name(s, "Old Phone")
check("manual account status", acc["feed"]["status"] == "manual" and acc["open"] == 1 and near(acc["upnl"], -5.0))

# Ladder add: new avg 58000, margin 40, liq from the app 47000, SL added
r = client.put(f"/mission/manual/{mid}", json={**base, "avg_entry": 58000, "margin": 40, "liq_price": 47000,
                                                "tp_price": 58600, "sl_price": 46500})
check("manual edit", r.status_code == 200, r.text)
mp = next(p for p in summary()["positions"] if p["id"] == mid)
# qty = 40 x 5 / 58000 = 0.0034483; uPnL = -1000 x qty = -3.4483; dist (57000-47000)/57000 = 17.544%
check("manual edit numbers", near(mp["qty"], 200 / 58000) and near(mp["unrealized_pnl"], -200 / 58)
      and not mp["liq_estimated"] and near(mp["liq_distance_pct"], 10000 / 57000 * 100))
check("manual tp/sl replaced", mp["tp_price"] == 58600 and mp["sl_price"] == 46500)

# A browser snapshot for the same name never closes manual trades
db = SessionLocal()
hub.apply_state(db, user_id=1, exchange="kcex", device="Old Phone", source="browser", credential_id=None,
                positions=[], orders=[])
db.close()
check("snapshot leaves manual trade", any(p["id"] == mid for p in summary()["positions"]))

# Price unavailable: the trade still shows, P&L unknown
PRICES.clear()
mp = next(p for p in summary()["positions"] if p["id"] == mid)
check("price missing", mp["price_missing"] and mp["unrealized_pnl"] is None and mp["liq_distance_pct"] is None)

check("validation", client.post("/mission/manual", json={**base, "margin": 0}).status_code == 422
      and client.post("/mission/manual", json={**base, "side": "up"}).status_code == 422)
check("close manual", client.delete(f"/mission/manual/{mid}").status_code == 204
      and not any(p["id"] == mid for p in summary()["positions"]))
check("closed cannot be edited", client.put(f"/mission/manual/{mid}", json=base).status_code == 409)
real = summary()["positions"][0]["id"]
check("api/browser rows are not editable", client.delete(f"/mission/manual/{real}").status_code == 404)

print(f"\n{len(PASSED)} checks passed")
