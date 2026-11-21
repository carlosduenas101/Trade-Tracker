"""
User settings tests — run with:  venv/Scripts/python backend/test_user_settings.py
Uses a TEMPORARY sqlite database (DATABASE_URL forced before any import).
"""
import os, sys, tempfile
from pathlib import Path

tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{Path(tmp, 't.db').as_posix()}"
os.environ.setdefault("ADMIN_SECRET", "x-admin")
os.environ["POOL_OWNER_USER_ID"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402
from database import SessionLocal, User  # noqa: E402
from auth import hash_password  # noqa: E402

fails = []
def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond: fails.append(name)

with TestClient(main.app) as c:
    db = SessionLocal()
    for n in ("alice", "bob"):
        db.add(User(username=n, email=f"{n}@x.io", hashed_password=hash_password("pw123456")))
    db.commit(); db.close()
    def tok(n): return {"Authorization": "Bearer " + c.post("/auth/login", json={"username": n, "password": "pw123456"}).json()["access_token"]}
    A, B = tok("alice"), tok("bob")

    check("unauthenticated GET is 401", c.get("/settings/exchanges").status_code == 401)
    check("new user starts empty", c.get("/settings/exchanges", headers=A).json() == {"exchanges": []})

    body = {"exchanges": [
        {"name": "KCEX", "enabled": True, "taker_fee_pct": 0.06},
        {"name": "Bitunix", "enabled": False},
    ]}
    r = c.put("/settings/exchanges", json=body, headers=A)
    check("save ok", r.status_code == 200)
    got = c.get("/settings/exchanges", headers=A).json()["exchanges"]
    check("persisted with optional fees null", got[0]["taker_fee_pct"] == 0.06 and got[0]["maker_fee_pct"] is None and got[1]["taker_fee_pct"] is None)
    check("enabled flag kept", got[1]["enabled"] is False)
    check("other user unaffected", c.get("/settings/exchanges", headers=B).json() == {"exchanges": []})

    check("negative fee rejected", c.put("/settings/exchanges", json={"exchanges": [{"name": "X", "taker_fee_pct": -1}]}, headers=A).status_code == 422)
    check("fee over 5 rejected", c.put("/settings/exchanges", json={"exchanges": [{"name": "X", "maker_fee_pct": 6}]}, headers=A).status_code == 422)
    check("blank name rejected", c.put("/settings/exchanges", json={"exchanges": [{"name": "   "}]}, headers=A).status_code == 422)
    check("duplicate (case-insens.) rejected", c.put("/settings/exchanges", json={"exchanges": [{"name": "kcex"}, {"name": "KCEX"}]}, headers=A).status_code == 422)
    check("failed save left data intact", len(c.get("/settings/exchanges", headers=A).json()["exchanges"]) == 2)

    r = c.put("/settings/exchanges", json={"exchanges": []}, headers=A)
    check("can clear list", r.status_code == 200 and c.get("/settings/exchanges", headers=A).json()["exchanges"] == [])

print("\n%d failed" % len(fails) if fails else "\nall passed")
sys.exit(1 if fails else 0)
