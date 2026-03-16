"""
KCEX Exchange integration module.

NOTE: Update base URL and endpoints from KCEX official API docs.
The base URL, endpoint paths, authentication header names, response
field mappings, and pagination logic below are all placeholders.
Replace them once the official KCEX API documentation is available.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from datetime import datetime, timezone
from typing import Any, Optional

import requests

# ---------------------------------------------------------------------------
# Placeholder constants — replace with values from KCEX official API docs
# ---------------------------------------------------------------------------

# NOTE: Update base URL and endpoints from KCEX official API docs
BASE_URL = "https://api.kcex.com"

ENDPOINTS = {
    # NOTE: Update base URL and endpoints from KCEX official API docs
    "trade_history": "/api/v1/trades/history",
    "account_info": "/api/v1/account",
    "ticker": "/api/v1/ticker",
}

# Default request timeout in seconds
REQUEST_TIMEOUT = 10

# Maximum number of trades to fetch per API page
PAGE_LIMIT = 100


# ---------------------------------------------------------------------------
# KCEX API client
# ---------------------------------------------------------------------------


class KCEXClient:
    """
    Lightweight KCEX REST API client.

    Authentication strategy and response shapes are placeholders.
    Adjust _build_headers(), _sign_request(), and _normalise_trade()
    once the official KCEX API docs are available.
    """

    def __init__(self, api_key: str, api_secret: str) -> None:
        self.api_key = api_key
        self.api_secret = api_secret
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _timestamp(self) -> str:
        """Return the current UTC timestamp in milliseconds as a string."""
        return str(int(time.time() * 1000))

    def _sign(self, message: str) -> str:
        """
        HMAC-SHA256 signature.

        NOTE: Update signing logic from KCEX official API docs.
        Many exchanges sign (timestamp + method + path + body);
        adjust the message construction to match KCEX requirements.
        """
        return hmac.new(
            self.api_secret.encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    def _build_headers(self, timestamp: str, signature: str) -> dict[str, str]:
        """
        Construct authentication headers.

        NOTE: Update header names from KCEX official API docs.
        Common patterns: X-API-KEY / X-API-SIGN / X-API-TIMESTAMP
        """
        return {
            # NOTE: Update header names from KCEX official API docs
            "X-API-KEY": self.api_key,
            "X-API-SIGN": signature,
            "X-API-TIMESTAMP": timestamp,
        }

    def _get(self, endpoint: str, params: Optional[dict] = None) -> Any:
        """
        Perform an authenticated GET request.

        Raises
        ------
        requests.HTTPError   on 4xx / 5xx responses.
        requests.Timeout     if the server does not respond in time.
        ConnectionError      on network-level failures.
        """
        url = BASE_URL + endpoint
        timestamp = self._timestamp()

        # Build signature message — adjust once KCEX docs are available
        query_string = "&".join(f"{k}={v}" for k, v in (params or {}).items())
        message = timestamp + "GET" + endpoint + ("?" + query_string if query_string else "")
        signature = self._sign(message)

        headers = self._build_headers(timestamp, signature)
        response = self.session.get(url, params=params, headers=headers, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        return response.json()

    # ------------------------------------------------------------------
    # Response normalisation
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_ts(value: Any) -> datetime:
        """
        Parse a timestamp from the KCEX response into a UTC datetime.

        NOTE: Update timestamp parsing from KCEX official API docs.
        Common formats: Unix ms integer, ISO-8601 string, Unix seconds.
        """
        if isinstance(value, (int, float)):
            # Assume Unix milliseconds — adjust if KCEX uses seconds
            return datetime.fromtimestamp(value / 1000, tz=timezone.utc).replace(tzinfo=None)
        if isinstance(value, str):
            # Attempt ISO-8601 parse
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
            except ValueError:
                return datetime.utcnow()
        return datetime.utcnow()

    def _normalise_trade(self, raw: dict) -> dict:
        """
        Map a raw KCEX trade record to the internal Trade model structure.

        NOTE: Update field names from KCEX official API docs.
        The field names used below (symbol, side, avgEntryPrice, etc.)
        are illustrative placeholders — replace with actual KCEX field names.
        """
        open_time = self._parse_ts(raw.get("openTime") or raw.get("open_time") or 0)
        close_time = self._parse_ts(raw.get("closeTime") or raw.get("close_time") or 0)
        duration = max(0, int((close_time - open_time).total_seconds() / 60))

        # NOTE: Replace placeholder field names with real KCEX field names
        entry_price = float(raw.get("avgEntryPrice") or raw.get("entry_price") or 0)
        exit_price = float(raw.get("avgExitPrice") or raw.get("exit_price") or 0)
        quantity = float(raw.get("qty") or raw.get("quantity") or 0)
        side = str(raw.get("side") or raw.get("direction") or "buy").lower()

        # Determine pnl — use exchange-provided value when available
        pnl_raw = raw.get("realizedPnl") or raw.get("pnl") or raw.get("profit")
        if pnl_raw is not None:
            pnl = round(float(pnl_raw), 8)
        else:
            # Fallback calculation (long only — adjust for shorts if needed)
            if side in ("buy", "long"):
                pnl = round((exit_price - entry_price) * quantity, 8)
            else:
                pnl = round((entry_price - exit_price) * quantity, 8)

        return {
            # NOTE: Update field names from KCEX official API docs
            "symbol": str(raw.get("symbol") or raw.get("pair") or "UNKNOWN"),
            "side": side,
            "entry_price": entry_price,
            "exit_price": exit_price,
            "quantity": quantity,
            "pnl": pnl,
            "is_win": pnl > 0,
            "open_time": open_time,
            "close_time": close_time,
            "duration_minutes": duration,
            "risk_reward": raw.get("riskReward") or raw.get("risk_reward"),
            "notes": None,
            "source": "api",
        }

    # ------------------------------------------------------------------
    # Public API methods
    # ------------------------------------------------------------------

    def get_trade_history(
        self,
        symbol: Optional[str] = None,
        start_time: Optional[int] = None,
        end_time: Optional[int] = None,
    ) -> list[dict]:
        """
        Fetch closed trade history from KCEX and return a list of dicts
        normalised to the internal Trade model structure.

        Parameters
        ----------
        symbol      Filter by trading pair, e.g. "BTC/USDT" (optional).
        start_time  Unix millisecond timestamp — fetch trades after this time.
        end_time    Unix millisecond timestamp — fetch trades before this time.

        Returns
        -------
        list[dict]  Each dict matches the Trade model field layout.

        NOTE: Update pagination and parameter names from KCEX official API docs.
        """
        params: dict[str, Any] = {"limit": PAGE_LIMIT}
        if symbol:
            # NOTE: Update parameter name from KCEX official API docs
            params["symbol"] = symbol
        if start_time:
            # NOTE: Update parameter name from KCEX official API docs
            params["startTime"] = start_time
        if end_time:
            # NOTE: Update parameter name from KCEX official API docs
            params["endTime"] = end_time

        endpoint = ENDPOINTS["trade_history"]

        try:
            response = self._get(endpoint, params=params)
        except requests.HTTPError as exc:
            raise RuntimeError(
                f"KCEX API returned HTTP {exc.response.status_code}: {exc.response.text}"
            ) from exc
        except requests.Timeout as exc:
            raise RuntimeError("KCEX API request timed out.") from exc
        except requests.ConnectionError as exc:
            raise RuntimeError(f"Could not connect to KCEX API: {exc}") from exc

        # NOTE: Update response parsing from KCEX official API docs.
        # Adjust the key used to extract the trade list ("data", "trades",
        # "result", etc.) to match the actual KCEX response envelope.
        raw_trades: list[dict] = []
        if isinstance(response, list):
            raw_trades = response
        elif isinstance(response, dict):
            # Common envelope patterns — add more as needed
            for key in ("data", "trades", "result", "records"):
                if key in response and isinstance(response[key], list):
                    raw_trades = response[key]
                    break

        return [self._normalise_trade(t) for t in raw_trades]

    def get_account_info(self) -> dict:
        """
        Fetch basic account information.

        NOTE: Update endpoint and response parsing from KCEX official API docs.
        """
        try:
            return self._get(ENDPOINTS["account_info"])
        except Exception as exc:
            raise RuntimeError(f"Failed to fetch account info: {exc}") from exc
