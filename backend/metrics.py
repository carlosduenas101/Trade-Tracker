"""
Metrics module.
Pure calculation functions — no database or HTTP dependencies.
All functions accept a plain list of trade dicts (or ORM Trade objects)
so they can be tested in isolation.
"""

from __future__ import annotations

from typing import Any, Union


# ---------------------------------------------------------------------------
# Type alias — a trade can be either an ORM object or a plain dict
# ---------------------------------------------------------------------------

TradeItem = Any  # Trade ORM instance or dict


def _get(trade: TradeItem, field: str, default=None):
    """Unified attribute/key access for ORM objects and dicts."""
    if isinstance(trade, dict):
        return trade.get(field, default)
    return getattr(trade, field, default)


# ---------------------------------------------------------------------------
# Individual metric calculators
# ---------------------------------------------------------------------------


def calculate_win_rate(trades: list[TradeItem]) -> float:
    """
    Return the percentage of winning trades.

    Returns 0.0 when the trade list is empty.
    """
    if not trades:
        return 0.0
    wins = sum(1 for t in trades if _get(t, "is_win", False))
    return round((wins / len(trades)) * 100, 2)


def calculate_total_pnl(trades: list[TradeItem]) -> float:
    """
    Return the sum of PnL across all trades.

    Returns 0.0 when the trade list is empty.
    """
    if not trades:
        return 0.0
    return round(sum(_get(t, "pnl", 0.0) or 0.0 for t in trades), 8)


def calculate_max_drawdown(trades: list[TradeItem]) -> float:
    """
    Calculate maximum drawdown from peak equity.

    Trades are assumed to be in chronological order (oldest first).
    Drawdown is expressed as a positive number representing the largest
    peak-to-trough decline in cumulative PnL.

    Returns 0.0 when there are fewer than 2 trades.
    """
    if len(trades) < 2:
        return 0.0

    peak = 0.0
    max_dd = 0.0
    cumulative = 0.0

    for trade in trades:
        cumulative += _get(trade, "pnl", 0.0) or 0.0
        if cumulative > peak:
            peak = cumulative
        drawdown = peak - cumulative
        if drawdown > max_dd:
            max_dd = drawdown

    return round(max_dd, 8)


def calculate_avg_duration(trades: list[TradeItem]) -> float:
    """
    Calculate the average trade duration in minutes.

    Returns 0.0 when no trades have a duration value.
    """
    values = [
        _get(t, "duration_minutes")
        for t in trades
        if _get(t, "duration_minutes") is not None and _get(t, "duration_minutes") > 0
    ]
    if not values:
        return 0.0
    return round(sum(values) / len(values), 2)


def calculate_avg_entries(trades: list[TradeItem]) -> float:
    """
    Calculate the average number of entries per trade.

    Returns 0.0 when no trades have an entries value.
    """
    values = [
        _get(t, "entries")
        for t in trades
        if _get(t, "entries") is not None
    ]
    if not values:
        return 0.0
    return round(sum(values) / len(values), 2)


def calculate_avg_roe(trades: list[TradeItem]) -> float:
    """
    Calculate the average ROE % across all trades that have a roe value.

    Returns 0.0 when no trades have a roe value.
    """
    roe_values = [
        _get(t, "roe")
        for t in trades
        if _get(t, "roe") is not None
    ]
    if not roe_values:
        return 0.0
    return round(sum(roe_values) / len(roe_values), 2)


def calculate_avg_rr(trades: list[TradeItem]) -> float:
    """
    Calculate average risk/reward ratio across trades that have an R:R value set.

    Returns 0.0 when no trades have a risk_reward value.
    """
    rr_values = [
        _get(t, "risk_reward")
        for t in trades
        if _get(t, "risk_reward") is not None
    ]
    if not rr_values:
        return 0.0
    return round(sum(rr_values) / len(rr_values), 4)


def calculate_streak(trades: list[TradeItem]) -> int:
    """
    Calculate the current win/loss streak from the most recent trade backwards.

    A positive integer means the last N trades were all wins.
    A negative integer means the last N trades were all losses.
    Returns 0 when the trade list is empty.

    Trades must be sorted chronologically (oldest first); the streak is
    counted from the end of the list.
    """
    if not trades:
        return 0

    streak = 0
    # Work backwards from the most recent trade
    last_is_win: bool | None = None

    for trade in reversed(trades):
        is_win = bool(_get(trade, "is_win", False))

        if last_is_win is None:
            # First iteration — establish the streak direction
            last_is_win = is_win
            streak = 1 if is_win else -1
        elif is_win == last_is_win:
            streak = streak + 1 if is_win else streak - 1
        else:
            # Streak broken — stop
            break

    return streak


# ---------------------------------------------------------------------------
# Aggregate convenience function
# ---------------------------------------------------------------------------


def get_all_metrics(trades: list[TradeItem]) -> dict:
    """
    Compute and return all performance metrics as a single dictionary.

    Keys
    ----
    win_rate        float  — percentage of winning trades (0–100)
    total_pnl       float  — sum of all PnL values
    max_drawdown    float  — largest peak-to-trough equity decline
    avg_rr          float  — average risk/reward ratio
    current_streak  int    — positive = wins, negative = losses
    total_trades    int    — number of trades in the dataset
    """
    streak = calculate_streak(trades)
    wins = sum(1 for t in trades if _get(t, "is_win", False))
    return {
        "win_rate": calculate_win_rate(trades),
        "total_pnl": calculate_total_pnl(trades),
        "max_drawdown": calculate_max_drawdown(trades),
        "avg_rr": calculate_avg_rr(trades),
        "avg_roe": calculate_avg_roe(trades),
        "avg_entries": calculate_avg_entries(trades),
        "avg_duration": calculate_avg_duration(trades),
        "current_streak": streak,
        "streak_type": "win" if streak > 0 else "loss" if streak < 0 else "",
        "total_trades": len(trades),
        "winning_trades": wins,
        "losing_trades": len(trades) - wins,
    }
