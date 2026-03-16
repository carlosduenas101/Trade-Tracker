"""
FastAPI application entry point.

Routes
------
GET    /trades          List all trades (filters: ?start_date= &end_date=)
POST   /trades          Manually add a trade
PUT    /trades/{id}     Edit an existing trade
DELETE /trades/{id}     Delete a trade
GET    /metrics         Performance metrics (filters: ?start_date= &end_date=)

Run with:
    uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

import config
from database import (
    SessionLocal,
    Trade,
    TradeCreate,
    TradeResponse,
    TradeUpdate,
    compute_duration,
    compute_pnl,
    get_db,
    init_db,
)
from metrics import get_all_metrics

# ---------------------------------------------------------------------------
# Application setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title=config.APP_TITLE,
    version=config.APP_VERSION,
    description=config.APP_DESCRIPTION,
)

# CORS — allow frontend dev servers to call the API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    """Initialise database tables on first run."""
    init_db()


# ---------------------------------------------------------------------------
# Serve frontend
# ---------------------------------------------------------------------------

_frontend = Path(__file__).parent.parent / "frontend"
app.mount("/static", StaticFiles(directory=str(_frontend)), name="static")


@app.get("/", include_in_schema=False)
def serve_index():
    return FileResponse(str(_frontend / "index.html"))


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _apply_date_filters(
    query,
    start_date: Optional[datetime],
    end_date: Optional[datetime],
):
    """Apply optional date range filters to a SQLAlchemy query on Trade."""
    if start_date:
        query = query.filter(Trade.close_time >= start_date)
    if end_date:
        query = query.filter(Trade.close_time <= end_date)
    return query


def _trade_from_create(data: TradeCreate) -> dict:
    """Build trade fields from a TradeCreate payload. PnL is user-provided."""
    duration = compute_duration(data.open_time, data.close_time)
    return {
        **data.model_dump(),
        "is_win": data.pnl > 0,
        "duration_minutes": duration,
    }


# ---------------------------------------------------------------------------
# GET /trades
# ---------------------------------------------------------------------------


@app.get("/trades", response_model=list[TradeResponse], tags=["Trades"])
def list_trades(
    start_date: Optional[datetime] = Query(
        None,
        description="Filter trades closed on or after this UTC datetime (ISO 8601).",
        example="2024-01-01T00:00:00",
    ),
    end_date: Optional[datetime] = Query(
        None,
        description="Filter trades closed on or before this UTC datetime (ISO 8601).",
        example="2024-12-31T23:59:59",
    ),
    db: Session = Depends(get_db),
) -> list[Trade]:
    """
    Return all trades, optionally filtered by close_time date range.
    Results are sorted oldest-first so that metric calculations work correctly.
    """
    query = db.query(Trade).order_by(Trade.close_time.asc())
    query = _apply_date_filters(query, start_date, end_date)
    return query.all()


# ---------------------------------------------------------------------------
# POST /trades
# ---------------------------------------------------------------------------


@app.post("/trades", response_model=TradeResponse, status_code=status.HTTP_201_CREATED, tags=["Trades"])
def create_trade(payload: TradeCreate, db: Session = Depends(get_db)) -> Trade:
    """
    Manually add a single completed trade.
    PnL and duration are calculated automatically from the provided prices.
    """
    if payload.close_time <= payload.open_time:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="close_time must be after open_time.",
        )

    fields = _trade_from_create(payload)
    trade = Trade(**fields)
    db.add(trade)
    db.commit()
    db.refresh(trade)
    return trade


# ---------------------------------------------------------------------------
# PUT /trades/{id}
# ---------------------------------------------------------------------------


@app.put("/trades/{trade_id}", response_model=TradeResponse, tags=["Trades"])
def update_trade(
    trade_id: int,
    payload: TradeUpdate,
    db: Session = Depends(get_db),
) -> Trade:
    """
    Edit an existing trade by ID.
    Only fields present in the request body are updated.
    PnL and duration are recalculated whenever price/time fields change.
    """
    trade = db.query(Trade).filter(Trade.id == trade_id).first()
    if not trade:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Trade not found.")

    update_data = payload.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(trade, field, value)

    # Recalculate derived fields after any update
    trade.is_win = trade.pnl > 0
    trade.duration_minutes = compute_duration(trade.open_time, trade.close_time)

    db.commit()
    db.refresh(trade)
    return trade


# ---------------------------------------------------------------------------
# DELETE /trades/{id}
# ---------------------------------------------------------------------------


@app.delete("/trades/{trade_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["Trades"])
def delete_trade(trade_id: int, db: Session = Depends(get_db)) -> None:
    """Delete a trade by ID. Returns 204 No Content on success."""
    trade = db.query(Trade).filter(Trade.id == trade_id).first()
    if not trade:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Trade not found.")
    db.delete(trade)
    db.commit()


# ---------------------------------------------------------------------------
# GET /metrics
# ---------------------------------------------------------------------------


@app.get("/metrics", tags=["Metrics"])
def get_metrics(
    start_date: Optional[datetime] = Query(
        None,
        description="Include only trades closed on or after this UTC datetime.",
        example="2024-01-01T00:00:00",
    ),
    end_date: Optional[datetime] = Query(
        None,
        description="Include only trades closed on or before this UTC datetime.",
        example="2024-12-31T23:59:59",
    ),
    db: Session = Depends(get_db),
) -> dict:
    """
    Return performance metrics computed across all (or filtered) trades.

    Metrics returned
    ----------------
    win_rate        Percentage of winning trades (0–100).
    total_pnl       Sum of all realised PnL.
    max_drawdown    Largest peak-to-trough equity decline.
    avg_rr          Average risk/reward ratio (trades with R:R set only).
    current_streak  Positive = current win streak, negative = loss streak.
    total_trades    Number of trades in the result set.
    """
    query = db.query(Trade).order_by(Trade.close_time.asc())
    query = _apply_date_filters(query, start_date, end_date)
    trades = query.all()
    return get_all_metrics(trades)


