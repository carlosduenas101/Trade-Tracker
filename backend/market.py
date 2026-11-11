"""
Market data — historical candles from the Bitunix public futures API.

Used by the Liq Ladder probability simulation in the calculator.

Route
-----
GET /market/klines?symbol=BTCUSDT&interval=5m&start=2025-01-01

The first request for a (symbol, interval, start) downloads the full history in a
background thread (Bitunix returns 200 candles per call) and answers
``202 {"status": "loading", "progress": 0.42}``. The client polls the same URL
until it gets ``200`` with the candles. Cached series are refreshed
incrementally (only new candles) when older than ``REFRESH_SECONDS``.

The browser cannot call Bitunix directly (no CORS), which is why this proxy exists.
"""

from __future__ import annotations

import gzip
import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

import requests
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from auth import get_current_user

log = logging.getLogger(__name__)

BITUNIX_KLINE_URL = "https://fapi.bitunix.com/api/v1/futures/market/kline"
PAGE_LIMIT = 200
WORKERS = 4
REFRESH_SECONDS = 15 * 60
INTERVAL_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400}
ROUTE_INTERVALS = ("5m", "15m", "1h", "4h")   # 1m is only used internally (paper trading)
SYMBOL_RE = re.compile(r"^[A-Z0-9]{2,20}USDT$")
EARLIEST_START = datetime(2024, 1, 1, tzinfo=timezone.utc)
CACHE_DIR = Path("/tmp/illustrade-klines")

router = APIRouter(prefix="/market", tags=["Market"])

# key -> {"status", "progress", "error", "series", "updated"}
_cache: dict[tuple[str, str, int], dict] = {}
_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Bitunix fetching
# ---------------------------------------------------------------------------

def fetch_page(symbol: str, interval: str, end_ms: int, session: Optional[requests.Session] = None) -> list[list[float]]:
    """One page of up to 200 candles ending at ``end_ms`` → [[t_sec, o, h, l, c], ...]."""
    http = session or requests
    params = {"symbol": symbol, "interval": interval, "limit": PAGE_LIMIT, "endTime": end_ms}
    last_err: Optional[Exception] = None
    for attempt in range(5):
        try:
            r = http.get(BITUNIX_KLINE_URL, params=params, timeout=15)
            r.raise_for_status()
            body = r.json()
            if body.get("code") != 0:
                raise RuntimeError(body.get("msg") or f"code {body.get('code')}")
            return [
                [int(row["time"]) // 1000, float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])]
                for row in body.get("data") or []
            ]
        except Exception as exc:  # retry on rate limits / network errors
            last_err = exc
            time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(f"Bitunix kline request failed: {last_err}")


def download_series(
    symbol: str, interval: str, start_sec: int, end_sec: int,
    progress: Callable[[float], None] = lambda p: None,
    page_fetcher: Optional[Callable[..., list]] = None,
) -> list[list[float]]:
    """Download every candle in [start_sec, end_sec) and return them sorted, de-duplicated."""
    step = INTERVAL_SECONDS[interval]
    span = PAGE_LIMIT * step
    ends = list(range(end_sec, start_sec, -span))
    if not ends:
        return []
    candles: dict[int, list[float]] = {}
    done = 0
    session = requests.Session()

    fetcher = page_fetcher or fetch_page

    def job(end: int) -> list:
        return fetcher(symbol, interval, end * 1000, session)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for rows in pool.map(job, ends):
            for row in rows:
                if start_sec <= row[0] < end_sec:
                    candles[row[0]] = row
            done += 1
            progress(done / len(ends))
    return [candles[t] for t in sorted(candles)]


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

def _disk_path(key: tuple[str, str, int]) -> Path:
    return CACHE_DIR / f"{key[0]}_{key[1]}_{key[2]}.json.gz"


def _load_disk(key: tuple[str, str, int]) -> Optional[list]:
    path = _disk_path(key)
    try:
        with gzip.open(path, "rt") as fh:
            return json.load(fh)
    except Exception:
        return None


def _save_disk(key: tuple[str, str, int], series: list) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with gzip.open(_disk_path(key), "wt") as fh:
            json.dump(series, fh)
    except Exception as exc:
        log.warning("kline cache write failed: %s", exc)


def _closed_until(interval: str) -> int:
    """Open time of the current (unfinished) candle — everything before it is closed."""
    step = INTERVAL_SECONDS[interval]
    return int(time.time()) // step * step


def _build(key: tuple[str, str, int], page_fetcher: Optional[Callable[..., list]] = None) -> None:
    symbol, interval, start_sec = key
    entry = _cache[key]
    try:
        series = _load_disk(key) or []
        until = _closed_until(interval)
        step = INTERVAL_SECONDS[interval]
        if series:
            begin = int(series[-1][0]) + step   # incremental refresh
        else:
            begin = start_sec

        def set_progress(p: float) -> None:
            entry["progress"] = round(p, 3)

        if begin < until:
            new = download_series(symbol, interval, begin, until, set_progress, page_fetcher)
            series = series + new
        if not series:
            raise RuntimeError(f"No candles returned for {symbol} {interval}")
        _save_disk(key, series)
        with _lock:
            entry.update(status="ready", progress=1.0, series=series, updated=time.time(), error=None)
    except Exception as exc:
        log.exception("kline download failed for %s", key)
        with _lock:
            entry.update(status="error", error=str(exc))


def get_series(symbol: str, interval: str, start_sec: int,
               page_fetcher: Optional[Callable[..., list]] = None, background: bool = True) -> dict:
    """Return the cache entry for this series, starting/refreshing the download when needed."""
    key = (symbol, interval, start_sec)
    with _lock:
        entry = _cache.setdefault(key, {"status": "idle", "progress": 0.0, "series": None, "updated": 0.0, "error": None})
        stale = entry["status"] == "ready" and time.time() - entry["updated"] > REFRESH_SECONDS
        must_start = entry["status"] in ("idle", "error") or stale
        if must_start:
            if entry["series"] is None:
                entry.update(status="loading", progress=0.0, error=None)
            else:
                entry["updated"] = time.time()  # serve the cached copy while it refreshes
    if must_start:
        if background:
            threading.Thread(target=_build, args=(key, page_fetcher), daemon=True).start()
        else:
            _build(key, page_fetcher)
    return entry


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@router.get("/klines")
def klines(
    symbol: str = Query(..., description="Bitunix futures symbol, e.g. BTCUSDT"),
    interval: str = Query("5m", description="5m, 15m, 1h or 4h"),
    start: str = Query("2025-01-01", description="UTC start date, YYYY-MM-DD"),
    current_user=Depends(get_current_user),
):
    symbol = symbol.upper().replace("/", "").replace("-", "")
    if not SYMBOL_RE.match(symbol):
        raise HTTPException(status_code=400, detail="Invalid symbol.")
    if interval not in ROUTE_INTERVALS:
        raise HTTPException(status_code=400, detail="Interval must be one of 5m, 15m, 1h, 4h.")
    try:
        start_dt = datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail="start must be YYYY-MM-DD.")
    start_dt = max(start_dt, EARLIEST_START)
    start_sec = int(start_dt.timestamp())

    entry = get_series(symbol, interval, start_sec)
    if entry["series"] is None:
        if entry["status"] == "error":
            raise HTTPException(status_code=502, detail=entry["error"] or "Download failed.")
        return JSONResponse(status_code=202, content={"status": "loading", "progress": entry["progress"]})

    s = entry["series"]
    return {
        "status": "ready",
        "symbol": symbol,
        "interval": interval,
        "count": len(s),
        "t": [int(r[0]) for r in s],
        "o": [r[1] for r in s],
        "h": [r[2] for r in s],
        "l": [r[3] for r in s],
        "c": [r[4] for r in s],
    }
