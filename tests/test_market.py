"""
Tests for backend/market.py (no network: Bitunix pages are faked).

Run from the repo root:
    pip install -r backend/requirements.txt httpx pytest
    python -m pytest tests/test_market.py -q
"""

import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import market  # noqa: E402

STEP = 300


def fake_pages(calls):
    """Bitunix-like pager: 200 descending candles ending before end_ms, price = minute index."""
    def fetch(symbol, interval, end_ms, session=None):
        calls.append(end_ms)
        step = market.INTERVAL_SECONDS[interval]
        end = end_ms // 1000 // step * step
        rows = []
        for k in range(1, market.PAGE_LIMIT + 1):
            t = end - k * step
            p = float(t // step)
            rows.append([t, p, p + 2, p - 1, p + 1])
        return rows
    return fetch


def test_download_series_is_complete_sorted_and_unique():
    calls = []
    start, end = 1_700_000_100 // STEP * STEP, (1_700_000_100 // STEP * STEP) + 1000 * STEP
    out = market.download_series("BTCUSDT", "5m", start, end, page_fetcher=fake_pages(calls))
    ts = [r[0] for r in out]
    assert ts == list(range(start, end, STEP)), "every candle in range, once, in order"
    assert len(calls) == 5, "1000 candles / 200 per page"


def test_get_series_builds_and_refreshes_incrementally(tmp_path, monkeypatch):
    monkeypatch.setattr(market, "CACHE_DIR", tmp_path)
    market._cache.clear()
    now = market._closed_until("5m")
    start = now - 450 * STEP
    calls = []
    entry = market.get_series("ETHUSDT", "5m", start, page_fetcher=fake_pages(calls), background=False)
    assert entry["status"] == "ready" and len(entry["series"]) == 450
    assert entry["series"][-1][0] == now - STEP, "last closed candle only"
    first_calls = len(calls)

    # Force a refresh: only the missing tail is downloaded and appended
    entry["series"] = entry["series"][:-10]
    market._save_disk(("ETHUSDT", "5m", start), entry["series"])
    entry["updated"] = time.time() - market.REFRESH_SECONDS - 1
    entry = market.get_series("ETHUSDT", "5m", start, page_fetcher=fake_pages(calls), background=False)
    assert len(entry["series"]) == 450
    assert len(calls) - first_calls == 1, "one page for the 10 new candles"


def test_route_validation_and_loading_then_ready(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setattr(market, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(market, "fetch_page", fake_pages([]))
    market._cache.clear()

    app = FastAPI()
    app.include_router(market.router)
    app.dependency_overrides[market.get_current_user] = lambda: object()
    client = TestClient(app)

    assert client.get("/market/klines", params={"symbol": "BTC;DROP", "interval": "5m"}).status_code == 400
    assert client.get("/market/klines", params={"symbol": "BTCUSDT", "interval": "2m"}).status_code == 400
    assert client.get("/market/klines", params={"symbol": "BTCUSDT", "start": "2025/01/01"}).status_code == 400

    start = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 3 * 86400))
    r = client.get("/market/klines", params={"symbol": "btc/usdt", "interval": "1h", "start": start})
    assert r.status_code in (200, 202)
    for _ in range(50):
        if r.status_code == 200:
            break
        assert r.json()["status"] == "loading"
        time.sleep(0.05)
        r = client.get("/market/klines", params={"symbol": "BTCUSDT", "interval": "1h", "start": start})
    body = r.json()
    assert r.status_code == 200 and body["status"] == "ready"
    assert body["symbol"] == "BTCUSDT" and body["count"] == len(body["t"]) == len(body["c"])
    import calendar
    start_sec = calendar.timegm(time.strptime(start, "%Y-%m-%d"))
    expected = (market._closed_until("1h") - start_sec) // 3600
    assert body["count"] == expected, "every closed 1h candle since the start date"
    assert body["t"][0] == start_sec and body["t"] == sorted(body["t"])


def test_market_route_is_not_swallowed_by_frontend_catch_all(tmp_path, monkeypatch):
    """In main.py the /market routes must win over the SPA catch-all route."""
    import os
    os.environ.setdefault("DATABASE_URL", f"sqlite:///{tmp_path / 't.db'}")
    from fastapi.testclient import TestClient
    import main
    r = TestClient(main.app).get("/market/klines", params={"symbol": "BTCUSDT"})
    assert r.status_code in (401, 403), "auth required → handled by the market router, not index.html"
