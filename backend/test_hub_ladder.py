"""Hub ladder tests: venv/Scripts/python backend/test_hub_ladder.py  (temp sqlite, fake exchange, no network)"""
import os, sys, tempfile
from datetime import datetime, timedelta
from pathlib import Path

TMP = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{(Path(TMP) / 'ladder_test.db').as_posix()}"
os.environ["POOL_OWNER_USER_ID"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient
import hub, hub_ladder as hl
from auth import require_pool_owner
from database import Base, SessionLocal, User, engine

Base.metadata.create_all(bind=engine)
app = FastAPI(); app.include_router(hub.router); app.include_router(hl.router)
app.dependency_overrides[require_pool_owner] = lambda: User(id=1)
client = TestClient(app)

def check(name, cond, extra=""):
    if not cond:
        print(f"FAIL  {name} {extra}"); sys.exit(1)
    print(f"ok    {name}")

def near(a, b, tol=1e-6): return abs(a - b) <= tol * max(1, abs(b))

# ── pure math ──
p = hl.plan_dorado("long", 10, 100.0, 1.0, 200.0)
r = p["rows"]
exp = [100.0]
for s in (1.618, 3.618, 4.236): exp.append(exp[-1] * (1 - s / 100))
check("dorado long prices each from previous", all(near(r[i]["price"], exp[i]) for i in range(4)))
check("dorado margins 5/10/20/65 of 200", [round(x["margin"], 6) for x in r[1:]] == [20.0, 40.0, 130.0] and near(r[0]["margin"], 10.0))
q2 = 20 * 10 / exp[1]
check("dorado E2 qty and cum", near(r[1]["qty"], q2) and near(r[1]["cum_qty"], 1 + q2))
check("dorado avg E2", near(r[1]["avg"], (100 + q2 * exp[1]) / (1 + q2)))
check("dorado sl 2.618% beyond E4 + tp 0.5% over avg", near(p["sl"], exp[3] * (1 - .02618)) and near(r[3]["tp"], r[3]["avg"] * 1.005))
check("dorado liq = avg*(1-1/10)", near(r[3]["liq"], r[3]["avg"] * 0.9))
ps = hl.plan_dorado("short", 10, 100.0, 1.0, 200.0)
check("dorado short mirrored", near(ps["rows"][1]["price"], 100 * 1.01618) and ps["sl"] > ps["rows"][3]["price"] and ps["rows"][3]["tp"] < ps["rows"][3]["avg"])
for bad in ({"weights": [1]}, {"spacing": [1, 2]}, {"junk": 1}, {"sl_pct": -1}):
    try: hl.plan_dorado("long", 10, 100, 1, 100, params=bad); ok = False
    except ValueError: ok = True
    check(f"dorado rejects {bad}", ok)
pl = hl.plan_liq("long", 10, 100.0, 1.0, 1000.0)
check("liq preset has rows and E2 tp-from-calc", len(pl["rows"]) >= 2 and pl["rows"][0]["status"] == "filled")
try: hl.plan_liq("long", 10, 100, 1, 1000, params={"bogus": 1}); ok = False
except ValueError: ok = True
check("liq rejects unknown param", ok)
check("round_qty floors", str(hl.round_qty(0.12999, 3)) == "0.129")

# ── fake exchange ──
class Fake:
    def __init__(s): s.calls = []; s.fail_on = None; s.pos_qty = 1.0; s.hedge = False; s.cancel_fail = []
    def pair(s, sym): return {"symbol": sym, "basePrecision": 4, "quotePrecision": 2, "minTradeVolume": "0.0001", "symbolStatus": "OPEN"}
    def raw_position(s, sym, pid): return {"positionId": pid, "qty": str(s.pos_qty), "positionMode": "HEDGE" if s.hedge else "ONE_WAY"}
    def place_limit_entry(s, sym, side, qty, price, cid, hedge):
        if s.fail_on == cid: raise hub.ExchangeError("boom")
        s.calls.append(("place", cid, qty, price, hedge)); return "O" + cid
    def cancel(s, sym, ids): s.calls.append(("cancel", tuple(ids))); return [{"clientId": c, "errorMsg": "x"} for c in s.cancel_fail]
    def set_position_tpsl(s, sym, pid, tp, sl): s.calls.append(("tpsl", tp, sl))
fake = Fake(); hl.trader_factory = lambda cred: fake

def setup():
    db = SessionLocal()
    for m in (hl.HubLadderEntry, hl.HubLadder, hub.HubOrder, hub.HubPosition, hub.HubCredential): db.query(m).delete()
    db.add(User(id=1, username="owner", email="o@x.com", hashed_password="x")) if not db.query(User).get(1) else None
    c = hub.HubCredential(user_id=1, exchange="bitunix", device="PC-1", api_key_enc="a", api_secret_enc="b", key_hint="…1", active=True,
                          last_sync_at=datetime.utcnow(), last_error=None)
    db.add(c); db.commit()
    pos = hub.HubPosition(user_id=1, exchange="bitunix", device="PC-1", credential_id=c.id, source="api", external_id="P1", symbol="BTCUSDT",
                          side="long", qty=1.0, avg_entry=100.0, leverage=10, status="open")
    db.add(pos); db.commit()
    return db, c, pos

db, cred, pos = setup()
body = {"position_id": pos.id, "preset": "dorado", "total_margin": 200}
os.environ.pop("HUB_TRADING_ENABLED", None); os.environ.pop("HUB_MAX_LADDER_MARGIN", None)
pl = client.post("/hub/ladders/plan", json=body).json()
check("plan works with trading disabled but cannot arm", pl["can_arm"] is False and any("disabled" in b for b in pl["blockers"]))
check("plan has string prices for exchange", all("price_str" in x for x in pl["rows"][1:]))
check("plan has no side effects", fake.calls == [])
r = client.post("/hub/ladders/arm", json={**body, "plan_hash": pl["plan_hash"], "confirm": True})
check("arm blocked when disabled (409)", r.status_code == 409 and fake.calls == [])

os.environ["HUB_TRADING_ENABLED"] = "1"
pl = client.post("/hub/ladders/plan", json=body).json()
check("no cap set blocks", any("server ceiling" in b for b in pl["blockers"]))
os.environ["HUB_MAX_LADDER_MARGIN"] = "500"
pl = client.post("/hub/ladders/plan", json=body).json()
check("ceiling set but no UI cap blocks", any("set your max ladder margin" in b for b in pl["blockers"]))
check("cap above ceiling rejected", client.put("/hub/ladders/settings", json={"max_ladder_margin": 501}).status_code == 400)
check("cap must be positive", client.put("/hub/ladders/settings", json={"max_ladder_margin": 0}).status_code == 422)
s_ = client.put("/hub/ladders/settings", json={"max_ladder_margin": 100}).json()
check("cap saved", s_["max_ladder_margin"] == 100 and s_["effective_cap"] == 100 and s_["ceiling"] == 500)
pl = client.post("/hub/ladders/plan", json=body).json()
check("over cap blocks", any("above your cap" in b for b in pl["blockers"]))
client.put("/hub/ladders/settings", json={"max_ladder_margin": 300})
os.environ["HUB_MAX_LADDER_MARGIN"] = "250"
check("lowered ceiling clamps the UI cap", client.get("/hub/ladders/settings").json()["effective_cap"] == 250)
os.environ["HUB_MAX_LADDER_MARGIN"] = "500"
pl = client.post("/hub/ladders/plan", json=body).json()
check("can_arm when all gates pass", pl["can_arm"] is True, str(pl["blockers"]))
check("no confirm -> 400", client.post("/hub/ladders/arm", json={**body, "plan_hash": pl["plan_hash"]}).status_code == 400)
check("bad hash -> 409", client.post("/hub/ladders/arm", json={**body, "plan_hash": "0" * 64, "confirm": True}).status_code == 409)
fake.pos_qty = 2.0
check("position changed on exchange -> 409", client.post("/hub/ladders/arm", json={**body, "plan_hash": pl["plan_hash"], "confirm": True}).status_code == 409)
fake.pos_qty = 1.0
check("nothing sent by rejected arms", fake.calls == [])

r = client.post("/hub/ladders/arm", json={**body, "plan_hash": pl["plan_hash"], "confirm": True})
check("arm ok", r.status_code == 200 and r.json()["status"] == "armed", r.text)
kinds = [c[0] for c in fake.calls]
check("SL/TP first then 3 entries", kinds == ["tpsl", "place", "place", "place"])
check("client ids GMH{id}E{n}", fake.calls[1][1].endswith("E2") and fake.calls[1][1].startswith("GMH"))
check("one-way mode sends no tradeSide", fake.calls[1][4] is False)
check("second arm blocked (active ladder)", client.post("/hub/ladders/plan", json=body).json()["can_arm"] is False)

# reconcile: E2 fills -> position grows, E2 order gone from book
lad = db.query(hl.HubLadder).first(); ents = db.query(hl.HubLadderEntry).order_by(hl.HubLadderEntry.n).all()
for e in ents[1:]:
    db.add(hub.HubOrder(user_id=1, exchange="bitunix", device="PC-1", source="api", order_id=e.order_id, client_id=e.client_id,
                        symbol="BTCUSDT", side="buy", kind="entry", price=e.price, qty=e.qty))
db.commit()
fake.calls.clear()
pos = db.query(hub.HubPosition).first(); pos.qty = ents[0].cum_qty; pos.avg_entry = 99.0; db.commit()
db.query(hub.HubOrder).filter_by(client_id=ents[0].client_id).delete(); db.commit()
cred = db.query(hub.HubCredential).first(); cred.last_sync_at = datetime.utcnow(); db.commit()
hl.reconcile_all(db); db.expire_all()
e0 = db.query(hl.HubLadderEntry).filter_by(client_id=ents[0].client_id).one()
check("fill detected", e0.status == "filled")
tp = [c for c in fake.calls if c[0] == "tpsl"]
check("TP follows new average", len(tp) == 1 and near(float(tp[0][1]), round(99.0 * 1.005, 2), 1e-4), str(tp))
fake.calls.clear(); hl.reconcile_all(db)
check("no repeat TP update when qty unchanged", not [c for c in fake.calls if c[0] == "tpsl"])

# stale data: never act
cred = db.query(hub.HubCredential).first(); cred.last_sync_at = datetime.utcnow() - timedelta(minutes=10); db.commit()
pos = db.query(hub.HubPosition).first(); pos.status = "closed"; db.commit()
fake.calls.clear(); hl.reconcile_all(db)
check("stale sync -> no action", fake.calls == [])
cred = db.query(hub.HubCredential).first(); cred.last_sync_at = datetime.utcnow(); db.commit()
fake.cancel_fail = [ents[1].client_id]
hl.reconcile_all(db); db.expire_all()
check("cancel refused -> ladder stays closing", db.query(hl.HubLadder).first().status == "closing")
fake.cancel_fail = []; hl.reconcile_all(db); db.expire_all()
check("position gone -> leftovers cancelled, ladder closed", db.query(hl.HubLadder).first().status == "closed"
      and all(e.status in ("cancelled", "filled") for e in db.query(hl.HubLadderEntry)))

# rollback on partial failure
db, cred, pos = setup(); fake.calls.clear(); fake.cancel_fail = []
pl = client.post("/hub/ladders/plan", json=body).json()
nextid = (db.query(hl.HubLadder).count() and 0) or None
fake.fail_on = None
import re
lid_guess = 1
r0 = None
fake.fail_on = "GMH1E4"
r = client.post("/hub/ladders/arm", json={**body, "plan_hash": pl["plan_hash"], "confirm": True})
check("partial failure -> 502, placed entries cancelled", r.status_code == 502 and ("cancel", ("GMH1E2", "GMH1E3")) in fake.calls, r.text + str(fake.calls))
check("failed ladder recorded", db.query(hl.HubLadder).first().status == "failed")

# non-bitunix: plan only
db, cred, pos = setup(); pos.exchange, pos.source = "kcex", "browser"; db.commit()
pl = client.post("/hub/ladders/plan", json=body).json()
check("kcex plan is manual-entry only", pl["can_arm"] is False and "by hand" in pl["blockers"][0])
r = client.post("/hub/ladders/arm", json={**body, "plan_hash": pl["plan_hash"], "confirm": True})
check("kcex arm refused", r.status_code == 409)
print("ALL OK")
