"""
Market pulse tests (ticker tape), run with:  venv/Scripts/python backend/test_market_pulse.py

No network: the Bitunix fetch is replaced by fixed candles. Every expected
number is worked out by hand in the comment next to it.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import os                                                    # noqa: E402
os.environ.setdefault("DATABASE_URL", f"sqlite:///{(Path(tempfile.mkdtemp()) / 'pulse.db').as_posix()}")

from fastapi import FastAPI, HTTPException                   # noqa: E402
from fastapi.testclient import TestClient                    # noqa: E402

import market                                                # noqa: E402
from auth import get_current_user                            # noqa: E402

PASSED = []


def check(name, cond, extra=""):
    if not cond:
        print(f"FAIL  {name} {extra}")
        sys.exit(1)
    PASSED.append(name)
    print(f"ok    {name}")


def near(a, b, tol=1e-9):
    return a is not None and abs(a - b) <= tol


# 3 candles, oldest first: open of the first = 100, close of the last = 110
ROWS = [[0, 100.0, 104.0, 99.0, 103.0], [900, 103.0, 108.0, 102.0, 107.0], [1800, 107.0, 112.0, 106.0, 110.0]]

p = market.summarize_pulse("BTCUSDT", ROWS)
check("price is last close", p["price"] == 110.0)
check("change vs first open", near(p["change_pct"], 10.0))          # (110 - 100) / 100 = 10 %
check("high / low over window", p["high"] == 112.0 and p["low"] == 99.0)
check("spark is closes", p["spark"] == [103.0, 107.0, 110.0])
check("empty -> None", market.summarize_pulse("BTCUSDT", []) is None)

# Window keeps only the newest PULSE_CANDLES candles
long_rows = [[i * 900, 50.0 + i, 50.0 + i, 50.0 + i, 50.0 + i] for i in range(market.PULSE_CANDLES + 3)]
lp = market.summarize_pulse("X", long_rows)
check("window trimmed", len(lp["spark"]) == market.PULSE_CANDLES and lp["spark"][0] == 53.0)   # first 3 dropped

# Cache: second call inside the TTL does not fetch again; failures are cached as None
calls = []


def fake_fetch(sym):
    calls.append(sym)
    if sym == "DEADUSDT":
        raise RuntimeError("boom")
    return ROWS


market._pulse_cache.clear()
market.get_pulse("BTCUSDT", fake_fetch)
market.get_pulse("BTCUSDT", fake_fetch)
check("cached within ttl", calls == ["BTCUSDT"])
check("failure -> None", market.get_pulse("DEADUSDT", fake_fetch) is None)
market.get_pulse("DEADUSDT", fake_fetch)
check("failure cached", calls.count("DEADUSDT") == 1)

# Symbol parsing
check("parse normalises", market.parse_symbols("btc/usdt, ETHUSDT ,eth-usdt") == ["BTCUSDT", "ETHUSDT"])
for bad in ("", " , ", "BTC", "BTC$USDT"):
    try:
        market.parse_symbols(bad)
        check(f"reject {bad!r}", False)
    except HTTPException as e:
        check(f"reject {bad!r}", e.status_code == 400)
try:
    market.parse_symbols(",".join(f"A{i:02d}USDT" for i in range(market.PULSE_MAX_SYMBOLS + 1)))
    check("too many symbols", False)
except HTTPException as e:
    check("too many symbols", e.status_code == 400)

# Route: items for symbols with data, the rest listed as missing; auth required
app = FastAPI()
app.include_router(market.router)
anon = TestClient(app)
check("route needs auth", anon.get("/market/pulse?symbols=BTCUSDT").status_code == 401)

app.dependency_overrides[get_current_user] = lambda: object()
client = TestClient(app)
market._pulse_cache.clear()
market._pulse_cache["DEADUSDT"] = (9e18, None)        # pinned failure
market._pulse_cache["BTCUSDT"] = (9e18, market.summarize_pulse("BTCUSDT", ROWS))
r = client.get("/market/pulse?symbols=BTCUSDT,DEADUSDT")
body = r.json()
check("route 200", r.status_code == 200, r.text)
check("route items", [i["symbol"] for i in body["items"]] == ["BTCUSDT"] and near(body["items"][0]["change_pct"], 10.0))
check("route missing", body["missing"] == ["DEADUSDT"])
check("route bad symbol 400", client.get("/market/pulse?symbols=NOPE").status_code == 400)

print(f"\n{len(PASSED)} checks passed")
