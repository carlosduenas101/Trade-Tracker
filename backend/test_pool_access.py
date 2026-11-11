"""
Fund Pool access-control tests — run with:  venv/Scripts/python backend/test_pool_access.py

Starts throwaway uvicorn servers on a TEMPORARY sqlite database (never the real
DB: DATABASE_URL is forced to a temp file and checked before anything starts)
and verifies, for every /fund-pool route:

  * the owner (POOL_OWNER_USER_ID) gets a 2xx
  * a second user gets 403 with no pool data in the body, on GET/POST/PATCH/DELETE
  * an unauthenticated request gets 401
  * with POOL_OWNER_USER_ID missing, EVERYONE (even the would-be owner) gets 403
    and the server logs a clear error at startup
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

BACKEND = Path(__file__).resolve().parent
ADMIN = "pool-test-admin-secret"
PW = "test-password-1"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, tmp, owner_env):
        self.db = Path(tmp) / f"pool_access_{owner_env or 'unset'}.db"
        url = f"sqlite:///{self.db.as_posix()}"
        assert url.startswith("sqlite:///") and "postgres" not in url  # never the real DB
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        env = dict(os.environ, DATABASE_URL=url, ADMIN_SECRET=ADMIN, POOL_OWNER_USER_ID=owner_env)
        self.log = Path(tmp) / f"server_{self.port}.log"
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(self.port)],
            cwd=BACKEND, env=env, stdout=open(self.log, "w"), stderr=subprocess.STDOUT,
        )
        for _ in range(80):
            try:
                urllib.request.urlopen(self.base + "/auth/me", timeout=1)
            except urllib.error.HTTPError:
                return
            except Exception:
                time.sleep(0.25)
        raise RuntimeError("server did not start:\n" + self.log.read_text())

    def stop(self):
        self.proc.terminate()
        self.proc.wait(10)

    def call(self, method, path, body=None, token=None):
        req = urllib.request.Request(self.base + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None)
        req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                raw = r.read()
                try:
                    return r.status, (json.loads(raw) if raw else None)
                except ValueError:
                    return r.status, raw.decode(errors="replace")
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, raw.decode(errors="replace")

    def make_user(self, name):
        req = urllib.request.Request(self.base + "/auth/users", method="POST",
                                     data=json.dumps({"username": name, "email": f"{name}@example.test", "password": PW}).encode())
        req.add_header("Content-Type", "application/json")
        req.add_header("X-Admin-Secret", ADMIN)
        urllib.request.urlopen(req, timeout=20).read()
        st, body = self.call("POST", "/auth/login", {"username": name, "password": PW})
        assert st == 200, (st, body)
        return body["access_token"]


def main():
    failures = []
    results = []
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        # ── Server A: owner configured (user id 1 = "owner_user") ───────────
        a = Server(tmp, "1")
        try:
            owner = a.make_user("owner_user")      # id 1
            other = a.make_user("second_user")     # id 2
            ok = lambda st: 200 <= st < 300

            # Owner builds real data through the real routes
            start = (date.today() - timedelta(days=100)).isoformat()
            st, inv = a.call("POST", "/fund-pool/investors", {"name": "Test Investor"}, owner); assert ok(st), (st, inv)
            st, c1 = a.call("POST", "/fund-pool/contributions", {"investor_id": inv["id"], "amount": 1000, "date_contributed": start, "payout_type": "monthly"}, owner); assert ok(st), (st, c1)
            st, c2 = a.call("POST", "/fund-pool/contributions", {"investor_id": inv["id"], "amount": 500, "date_contributed": start, "payout_type": "compound"}, owner); assert ok(st), (st, c2)
            st, led = a.call("GET", f"/fund-pool/contributions/{c1['id']}/ledger", None, owner); assert ok(st), (st, led)
            rows = led["ledger"]; assert len(rows) >= 2, rows
            r0, r1 = rows[0]["id"], rows[1]["id"]
            st, snap = a.call("POST", "/fund-pool/equity-snapshots", {"snapshot_date": date.today().isoformat(), "account_equity": 5000}, owner); assert ok(st), (st, snap)

            routes = [
                ("POST   /fund-pool/investors", "POST", "/fund-pool/investors", {"name": "Intruder"}),
                ("PATCH  /fund-pool/investors/{id}", "PATCH", f"/fund-pool/investors/{inv['id']}", {"contact": "x"}),
                ("POST   /fund-pool/contributions", "POST", "/fund-pool/contributions", {"investor_id": inv["id"], "amount": 50, "date_contributed": start, "payout_type": "monthly"}),
                ("GET    /fund-pool/contributions", "GET", "/fund-pool/contributions", None),
                ("GET    /fund-pool/contributions/{id}/ledger", "GET", f"/fund-pool/contributions/{c1['id']}/ledger", None),
                ("PATCH  /fund-pool/ledger/{id}/set-action", "PATCH", f"/fund-pool/ledger/{r0}/set-action", {"period_action": "compound"}),
                ("PATCH  /fund-pool/ledger/{id}/mark-paid", "PATCH", f"/fund-pool/ledger/{r0}/mark-paid", {"payment_method": "cash", "period_action": "paid"}),
                ("PATCH  /fund-pool/ledger/{id}", "PATCH", f"/fund-pool/ledger/{r1}", {"amount": 12.5}),
                ("PATCH  /fund-pool/contributions/{id}", "PATCH", f"/fund-pool/contributions/{c1['id']}", {"amount": 1100}),
                ("POST   /fund-pool/contributions/{id}/withdraw", "POST", f"/fund-pool/contributions/{c2['id']}/withdraw", {"payment_method": "cash"}),
                ("GET    /fund-pool/summary", "GET", "/fund-pool/summary", None),
                ("GET    /fund-pool/growth", "GET", "/fund-pool/growth", None),
                ("POST   /fund-pool/equity-snapshots", "POST", "/fund-pool/equity-snapshots", {"snapshot_date": (date.today() + timedelta(days=1)).isoformat(), "account_equity": 5100}),
                ("GET    /fund-pool/equity-snapshots", "GET", "/fund-pool/equity-snapshots", None),
                ("GET    /fund-pool/owner-summary", "GET", "/fund-pool/owner-summary", None),
                ("GET    /fund-pool/equity-composition", "GET", "/fund-pool/equity-composition", None),
                ("DELETE /fund-pool/equity-snapshots/{id}", "DELETE", f"/fund-pool/equity-snapshots/{snap['id']}", None),
            ]
            # Intruder and anonymous first, so a successful write would show up afterwards
            before = a.call("GET", "/fund-pool/contributions", None, owner)[1]
            for label, m, p, b in routes:
                st_o, body_o = a.call(m, p, b, other)
                st_n, _ = a.call(m, p, b, None)
                if st_o != 403 or body_o != {"detail": "Forbidden."}:
                    failures.append(f"{label}: second user got {st_o} {json.dumps(body_o)[:120]}")
                if st_n != 401:
                    failures.append(f"{label}: anonymous got {st_n}")
                results.append([label, None, st_o, st_n])
            after = a.call("GET", "/fund-pool/contributions", None, owner)[1]
            if before != after:
                failures.append("pool changed after the second user's write attempts")
            # Owner pass (the delete is last)
            for row, (label, m, p, b) in zip(results, routes):
                st_ow, body_ow = a.call(m, p, b, owner)
                if not ok(st_ow):
                    failures.append(f"{label}: owner got {st_ow} {str(body_ow)[:120]}")
                row[1] = st_ow
            # Pool data must not appear in unrelated endpoints for the second user
            for path in ("/metrics", "/trades", "/export", "/auth/me"):
                st, body = a.call("GET", path, None, other)
                blob = body if isinstance(body, str) else json.dumps(body)
                for needle in ("Test Investor", "investor", "fund-pool", "liability"):
                    if needle in blob.lower():
                        failures.append(f"{path} for second user mentions {needle!r}")
        finally:
            a.stop()

        # ── Server B: POOL_OWNER_USER_ID missing → deny everyone ────────────
        b = Server(tmp, "")
        try:
            u1 = b.make_user("would_be_owner")   # id 1
            for label, m, p, body in [
                ("GET /fund-pool/summary", "GET", "/fund-pool/summary", None),
                ("GET /fund-pool/contributions", "GET", "/fund-pool/contributions", None),
                ("POST /fund-pool/investors", "POST", "/fund-pool/investors", {"name": "x"}),
                ("DELETE /fund-pool/equity-snapshots/1", "DELETE", "/fund-pool/equity-snapshots/1", None),
            ]:
                st, rb = b.call(m, p, body, u1)
                if st != 403 or rb != {"detail": "Forbidden."}:
                    failures.append(f"owner unset: {label} gave {st} {rb}")
            time.sleep(0.5)
            if "POOL_OWNER_USER_ID is missing" not in b.log.read_text():
                failures.append("startup: no error logged when POOL_OWNER_USER_ID is missing")
        finally:
            b.stop()

    print(f"{'route':50} {'owner':>6} {'other':>6} {'anon':>5}")
    for label, o, x, n in results:
        print(f"{label:50} {o!s:>6} {x!s:>6} {n!s:>5}")
    print("owner unset -> everyone 403 + startup error logged:",
          "FAIL" if any(f.startswith(("owner unset", "startup")) for f in failures) else "ok")
    if failures:
        print("\nFAILURES:")
        for f in failures:
            print(" -", f)
        sys.exit(1)
    print("all fund-pool access tests passed")


if __name__ == "__main__":
    main()
