"""
Position Hub tests, run with:  venv/Scripts/python backend/test_hub.py

Uses a TEMPORARY sqlite database (DATABASE_URL is forced before anything is
imported) and a mini FastAPI app that mounts only the hub router, so nothing
touches the real database or any exchange. Exchange HTTP is never called.
"""

import hashlib
import hmac
import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

TMP = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{(Path(TMP) / 'hub_test.db').as_posix()}"
os.environ["POOL_OWNER_USER_ID"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parent))

from cryptography.fernet import Fernet                      # noqa: E402
from fastapi import FastAPI                                  # noqa: E402
from fastapi.testclient import TestClient                    # noqa: E402

import hub                                                   # noqa: E402
from auth import require_pool_owner                          # noqa: E402
from database import Base, SessionLocal, User, engine, get_db  # noqa: E402

Base.metadata.create_all(bind=engine)

app = FastAPI()
app.include_router(hub.router)
app.dependency_overrides[require_pool_owner] = lambda: User(id=1)
client = TestClient(app)

PASSED = []


def check(name, cond, extra=""):
    if not cond:
        print(f"FAIL  {name} {extra}")
        sys.exit(1)
    PASSED.append(name)
    print(f"ok    {name}")


def fresh_db():
    db = SessionLocal()
    for m in (hub.HubOrder, hub.HubPosition, hub.HubCredential):
        db.query(m).delete()
    db.commit()
    return db


# ── 1. Bitunix signing ─────────────────────────────────────────────────────
def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


nonce, ts, key, secret = "123456", "1724285700000", "yourApiKey", "yourSecretKey"
query = {"uid": "200", "id": "1"}                      # unsorted on purpose
body = '{"uid":"2899","arr":[{"id":1,"name":"maple"}]}'
expected = sha(sha(nonce + ts + key + "id1uid200" + body) + secret)
check("bitunix sign: sorted key+value query, body, double SHA-256",
      hub.bitunix_sign(nonce, ts, key, secret, query, body) == expected)
check("bitunix sign: empty query/body",
      hub.bitunix_sign(nonce, ts, key, secret, {}, "") == sha(sha(nonce + ts + key) + secret))

# ── 2. LBank signing ───────────────────────────────────────────────────────
prepared = ("api_key=K&echostr=ABC&signature_method=HmacSHA256&symbol=BTCUSDT&timestamp=1700000000000")
md5 = hashlib.md5(prepared.encode()).hexdigest().upper()
exp_l = hmac.new(b"S", md5.encode(), hashlib.sha256).hexdigest()
check("lbank sign: sorted params, MD5 upper, HMAC-SHA256",
      hub.lbank_sign({"symbol": "BTCUSDT"}, "S", "K", "HmacSHA256", "1700000000000", "ABC") == exp_l)

# ── 3. Normalisers ─────────────────────────────────────────────────────────
p = hub.BitunixClient.norm_position({
    "positionId": 77, "symbol": "XRPUSDT", "side": "LONG", "qty": "120.5", "avgOpenPrice": "2.31",
    "leverage": 5, "margin": "55.7", "unrealizedPNL": "-1.2", "liqPrice": "0",
    "marginMode": "ISOLATION", "ctime": 1731400000000})
check("bitunix position: side lowercased, liqPrice 0 -> None, margin float",
      p["side"] == "long" and p["liq_price"] is None and p["margin"] == 55.7 and p["external_id"] == "77")
o = hub.BitunixClient.norm_order({"orderId": 9, "symbol": "XRPUSDT", "side": "BUY", "qty": "10",
                                  "price": "2.2", "tradeQty": "0", "reduceOnly": False, "status": "NEW"})
x = hub.BitunixClient.norm_order({"orderId": 10, "symbol": "XRPUSDT", "side": "SELL", "qty": "10",
                                  "price": "2.6", "reduceOnly": True, "tpPrice": "2.6"})
check("bitunix order: reduceOnly decides entry vs exit", o["kind"] == "entry" and x["kind"] == "exit"
      and x["tp_price"] == 2.6)

# ── 4. apply_state: open / vanish / reopen, orders replaced ────────────────
db = fresh_db()
pos = lambda eid, **k: {"external_id": eid, "symbol": "XRPUSDT", "side": "long", "qty": 100.0,
                        "avg_entry": 2.3, "leverage": 5.0, "margin": 46.0, "unrealized_pnl": 0.5,
                        "liq_price": 1.9, "margin_mode": "isolation", **k}
ordr = lambda oid, price, **k: {"order_id": oid, "symbol": "XRPUSDT", "side": "buy", "kind": "entry",
                                "price": price, "qty": 50.0, **k}
scope = dict(user_id=1, exchange="bitunix", device="PC-1", source="api", credential_id=1)
hub.apply_state(db, **scope, positions=[pos("a"), pos("b", symbol="HBARUSDT")], orders=[ordr("o1", 2.2)])
check("apply_state: two open positions", db.query(hub.HubPosition).filter_by(status="open").count() == 2)
hub.apply_state(db, **scope, positions=[pos("a", qty=150.0)], orders=[ordr("o2", 2.1), ordr("o3", 2.0)])
rows = {r.external_id: r for r in db.query(hub.HubPosition).all()}
check("apply_state: vanished position is closed, other updated",
      rows["b"].status == "closed" and rows["b"].closed_at and rows["a"].qty == 150.0)
check("apply_state: orders replaced, not appended", db.query(hub.HubOrder).count() == 2)
hub.apply_state(db, **scope, positions=[pos("a"), pos("b", symbol="HBARUSDT")], orders=[])
check("apply_state: returning id reopens, no duplicate rows",
      db.query(hub.HubPosition).count() == 2 and db.query(hub.HubPosition).filter_by(status="open").count() == 2)
hub.apply_state(db, **dict(scope, device="PC-2"), positions=[pos("a")], orders=[])
check("apply_state: same exchange id on another device is a separate row",
      db.query(hub.HubPosition).filter_by(external_id="a").count() == 2)
db.close()

# ── 5. Credentials: encrypted at rest, secret never returned ───────────────
db = fresh_db()
db.close()
os.environ.pop("HUB_ENCRYPTION_KEY", None)
r = client.post("/hub/credentials", json={"exchange": "bitunix", "device": "PC-1",
                                          "api_key": "abcd1234efgh5678", "api_secret": "TOPSECRET123"})
check("credentials: 503 when HUB_ENCRYPTION_KEY is missing", r.status_code == 503)
os.environ["HUB_ENCRYPTION_KEY"] = Fernet.generate_key().decode()
r = client.post("/hub/credentials", json={"exchange": "bitunix", "device": "PC-1",
                                          "api_key": "abcd1234efgh5678", "api_secret": "TOPSECRET123"})
check("credentials: created", r.status_code == 201 and r.json()["key_hint"] == "abcd…5678")
listed = client.get("/hub/credentials")
check("credentials: secret and full key never in the API response",
      "TOPSECRET123" not in listed.text and "abcd1234efgh5678" not in listed.text)
db = SessionLocal()
c = db.query(hub.HubCredential).first()
check("credentials: stored encrypted, decrypts back",
      "TOPSECRET123" not in c.api_secret_enc and hub.decrypt(c.api_secret_enc) == "TOPSECRET123")

# ── 6. sync_credential failure keeps old data and records why ──────────────
hub.apply_state(db, user_id=1, exchange="bitunix", device="PC-1", source="api", credential_id=c.id,
                positions=[pos("a")], orders=[])


class Boom:
    def fetch_state(self):
        raise hub.ExchangeError("Bitunix error 10003: Invalid sign")


orig = hub.make_client
hub.make_client = lambda cred: Boom()
hub.sync_credential(db, c)
check("sync failure: old positions kept, error recorded",
      db.query(hub.HubPosition).filter_by(status="open").count() == 1 and "Invalid sign" in (c.last_error or ""))
hub.make_client = orig
c.exchange = "lbank"
hub.sync_credential(db, c)
check("lbank without endpoint config reports 'not configured' (no guessing)",
      (c.last_error or "").startswith("not configured") and db.query(hub.HubPosition).filter_by(status="open").count() == 1)
db.close()

# ── 7. KCEX ingest auth ────────────────────────────────────────────────────
snap = {"device": "PC-2", "positions": [{"symbol": "BTCUSDT", "side": "short", "qty": 0.01,
                                         "avg_entry": 90000, "leverage": 4, "margin": 225,
                                         "unrealized_pnl": 3.1, "liq_price": 110000}],
        "orders": [{"symbol": "BTCUSDT", "side": "sell", "price": 91000, "qty": 0.01}]}
for k in ("HUB_INGEST_TOKEN", "HUB_INGEST_USER_ID"):
    os.environ.pop(k, None)
check("ingest: denied when server env is unset", client.post("/hub/kcex/snapshot", json=snap,
                                                             headers={"X-Hub-Token": "x"}).status_code == 403)
os.environ["HUB_INGEST_TOKEN"], os.environ["HUB_INGEST_USER_ID"] = "tok-123", "1"
check("ingest: denied without token", client.post("/hub/kcex/snapshot", json=snap).status_code == 403)
check("ingest: denied with wrong token", client.post("/hub/kcex/snapshot", json=snap,
                                                     headers={"X-Hub-Token": "nope"}).status_code == 403)
r = client.post("/hub/kcex/snapshot", json=snap, headers={"X-Hub-Token": "tok-123"})
check("ingest: accepted with the right token", r.status_code == 200 and r.json()["positions"] == 1)

# ── 8. /hub/positions: grouping, pending entries order, stale flag ─────────
db = SessionLocal()
db.query(hub.HubOrder).delete()
db.query(hub.HubPosition).filter_by(exchange="bitunix").delete()
db.commit()
hub.apply_state(db, user_id=1, exchange="bitunix", device="PC-1", source="api", credential_id=1,
                positions=[pos("L1", symbol="XRPUSDT", side="long")],
                orders=[ordr("e1", 2.0), ordr("e2", 2.2), ordr("e3", 2.1),
                        {"order_id": "t1", "symbol": "XRPUSDT", "side": "sell", "kind": "exit",
                         "price": 2.6, "qty": 100.0, "tp_price": 2.6}])
data = client.get("/hub/positions").json()
xrp = next(p for p in data["positions"] if p["symbol"] == "XRPUSDT" and p["exchange"] == "bitunix")
check("positions: long pending entries listed nearest fill first (high to low)",
      [e["price"] for e in xrp["pending_entries"]] == [2.2, 2.1, 2.0])
check("positions: exit order and TP shown", xrp["tp_price"] == 2.6 and len(xrp["exit_orders"]) == 1)
check("positions: devices summarised", {d["device"] for d in data["devices"]} == {"PC-1", "PC-2"})
check("positions: fresh rows are not stale", not xrp["stale"])
kc = next(p for p in data["positions"] if p["exchange"] == "kcex")
check("positions: kcex row marked as browser source", kc["source"] == "browser" and kc["device"] == "PC-2")
old = datetime.utcnow() - timedelta(seconds=hub.BROWSER_STALE_SECONDS + 30)
db.query(hub.HubPosition).filter_by(exchange="kcex").update({"last_seen_at": old})
db.commit()
kc = next(p for p in client.get("/hub/positions").json()["positions"] if p["exchange"] == "kcex")
check("positions: old KCEX snapshot flagged stale", kc["stale"] is True)
db.close()

# ── 9. KCEX payload exactly as kcex_reader.js produces it (TP as an exit order) ──
db = SessionLocal()
db.query(hub.HubOrder).filter_by(exchange="kcex").delete()
db.query(hub.HubPosition).filter_by(exchange="kcex").delete()
db.commit()
live = {"device": "PC-2",
        "positions": [{"symbol": "BTCUSDT", "side": "long", "qty": 0.06728202, "avg_entry": 73231.9,
                       "leverage": 10, "margin": 512.4, "unrealized_pnl": -191.17,
                       "liq_price": 66274.2, "margin_mode": "isolated"}],
        "orders": [{"symbol": "BTCUSDT", "side": "sell", "kind": "exit", "price": 80000,
                    "qty": 0.06728202, "tp_price": 80000, "order_id": "BTCUSDT:long:tp"}]}
r = client.post("/hub/kcex/snapshot", json=live, headers={"X-Hub-Token": "tok-123"})
check("kcex live-shaped payload accepted", r.status_code == 200)
k = next(p for p in client.get("/hub/positions").json()["positions"] if p["exchange"] == "kcex")
check("kcex TP shows on the position, margin and leverage kept",
      k["tp_price"] == 80000 and k["margin"] == 512.4 and k["leverage"] == 10 and k["sl_price"] is None)
client.post("/hub/kcex/snapshot", json={"device": "PC-2", "positions": [], "orders": []},
            headers={"X-Hub-Token": "tok-123"})
check("kcex empty snapshot closes the position",
      not [p for p in client.get("/hub/positions").json()["positions"] if p["exchange"] == "kcex"])
db.close()

# ── 10. LBank page snapshot (live shape: 3 pairs, TP as exit orders) ───────
lb = {"exchange": "lbank", "device": "PC-1",
      "positions": [
          {"symbol": "XRPUSDT", "side": "long", "qty": 24.7, "avg_entry": 1.0894, "leverage": 3, "margin": 8.9701,
           "unrealized_pnl": -1.7043, "liq_price": None, "margin_mode": "cross"},
          {"symbol": "ETHUSDT", "side": "long", "qty": 0.014, "avg_entry": 2074.45, "leverage": 3, "margin": 9.6808,
           "unrealized_pnl": -1.1718, "liq_price": None, "margin_mode": "cross"},
          {"symbol": "BTCUSDT", "side": "long", "qty": 0.0003, "avg_entry": 71959.5, "leverage": 3, "margin": 7.1863,
           "unrealized_pnl": -0.5093, "liq_price": 48125.8, "margin_mode": "isolated"}],
      "orders": [{"symbol": "XRPUSDT", "side": "sell", "kind": "exit", "price": 1.37, "qty": 24.7,
                  "tp_price": 1.37, "order_id": "XRPUSDT:long:tp"}]}
client.post("/hub/kcex/snapshot", json=live, headers={"X-Hub-Token": "tok-123"})   # KCEX position on PC-2
r = client.post("/hub/kcex/snapshot", json=lb, headers={"X-Hub-Token": "tok-123"})
check("lbank snapshot accepted", r.status_code == 200 and r.json()["positions"] == 3)
allp = client.get("/hub/positions").json()["positions"]
lbp = [p for p in allp if p["exchange"] == "lbank"]
check("lbank rows stored as browser source with margin in $, no liq price on cross",
      len(lbp) == 3 and all(p["source"] == "browser" for p in lbp)
      and next(p for p in lbp if p["symbol"] == "XRPUSDT")["liq_price"] is None
      and next(p for p in lbp if p["symbol"] == "BTCUSDT")["margin"] == 7.1863)
check("lbank TP shows on its position", next(p for p in lbp if p["symbol"] == "XRPUSDT")["tp_price"] == 1.37)
check("an lbank snapshot does not touch the KCEX position",
      any(p["exchange"] == "kcex" and p["symbol"] == "BTCUSDT" for p in allp))
client.post("/hub/kcex/snapshot", json={"exchange": "lbank", "device": "PC-1", "positions": [], "orders": []},
            headers={"X-Hub-Token": "tok-123"})
allp = client.get("/hub/positions").json()["positions"]
check("empty lbank snapshot closes only lbank rows",
      not [p for p in allp if p["exchange"] == "lbank"] and any(p["exchange"] == "kcex" for p in allp))
r = client.post("/hub/kcex/snapshot", json={"exchange": "binance", "device": "PC-1"}, headers={"X-Hub-Token": "tok-123"})
check("unknown exchange rejected", r.status_code == 422)

print(f"\n{len(PASSED)} checks passed")
