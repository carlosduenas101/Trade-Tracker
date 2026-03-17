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

import csv
import io
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
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
    import logging
    db_type = "sqlite" if config.DATABASE_URL.startswith("sqlite") else "postgresql"
    logging.info(f"Connecting to database type: {db_type}")
    try:
        init_db()
        logging.info("Database initialised successfully.")
    except Exception as exc:
        logging.error(f"Database init failed: {exc}")
        raise


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
# GET /trades/template  — download a blank CSV template
# ---------------------------------------------------------------------------

_CSV_COLUMNS = [
    "symbol", "side", "entry_price", "exit_price", "quantity",
    "pnl", "roe", "leverage", "risk_reward", "entries",
    "open_time", "close_time", "notes",
]

@app.get("/template", tags=["Trades"], include_in_schema=True)
def download_template():
    """Return a blank CSV file with the correct column headers."""
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(_CSV_COLUMNS)
    writer.writerow([
        "BTC/USDT", "long", "60000", "62000", "0.1",
        "200", "3.33", "10", "2.0", "1",
        "2024-01-01T10:00:00", "2024-01-01T12:00:00", "Example trade",
    ])
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=trades_template.csv"},
    )


# ---------------------------------------------------------------------------
# POST /import  — bulk import trades from CSV
# ---------------------------------------------------------------------------

_COL_ALIASES = {
    "entry": "entry_price", "exit": "exit_price",
    "qty": "quantity", "rr": "risk_reward",
    "open_date": "open_time", "close_date": "close_time",
    "profit": "pnl", "profit_loss": "pnl",
}


def _normalise_row(row: dict) -> dict:
    """Lowercase keys and apply aliases."""
    return {_COL_ALIASES.get(k.strip().lower(), k.strip().lower()): v.strip() for k, v in row.items()}


def _parse_float(val: str):
    try:
        return float(val) if val else None
    except ValueError:
        return None


def _parse_int(val: str):
    try:
        return int(val) if val else None
    except ValueError:
        return None


_DT_FORMATS = [
    "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M",    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",          "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y %H:%M",    "%m/%d/%Y",
    "%d/%m/%Y %H:%M:%S", "%d/%m/%Y",
]

def _parse_dt(val: str):
    if not val:
        return None
    for fmt in _DT_FORMATS:
        try:
            return datetime.strptime(val.strip(), fmt)
        except ValueError:
            continue
    return None


@app.post("/import", tags=["Trades"])
async def import_trades(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """
    Bulk import trades from a CSV file.
    Download /trades/template for the expected column format.
    """
    content = await file.read()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")

    # Auto-detect delimiter (tab or comma)
    sample = text[:2048]
    delimiter = '\t' if sample.count('\t') > sample.count(',') else ','
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    imported = 0
    errors = []

    for i, raw_row in enumerate(reader, start=2):  # row 1 is header
        row = _normalise_row(raw_row)
        try:
            symbol = row.get("symbol", "").upper()
            side = row.get("side", "").lower()
            entry_price = _parse_float(row.get("entry_price", ""))
            exit_price = _parse_float(row.get("exit_price", ""))
            quantity = _parse_float(row.get("quantity", ""))
            pnl = _parse_float(row.get("pnl", ""))
            open_time = _parse_dt(row.get("open_time", ""))
            close_time = _parse_dt(row.get("close_time", ""))

            missing = [f for f, v in [
                ("symbol", symbol), ("side", side),
                ("entry_price", entry_price), ("exit_price", exit_price),
                ("quantity", quantity), ("pnl", pnl),
                ("open_time", open_time), ("close_time", close_time),
            ] if not v and v != 0]
            if missing:
                errors.append(f"Row {i}: missing {', '.join(missing)}")
                continue

            if close_time <= open_time:
                errors.append(f"Row {i}: close_time must be after open_time")
                continue

            trade = Trade(
                symbol=symbol,
                side=side,
                entry_price=entry_price,
                exit_price=exit_price,
                quantity=quantity,
                pnl=pnl,
                roe=_parse_float(row.get("roe", "")),
                leverage=_parse_float(row.get("leverage", "")),
                risk_reward=_parse_float(row.get("risk_reward", "")),
                entries=_parse_int(row.get("entries", "")),
                open_time=open_time,
                close_time=close_time,
                notes=row.get("notes") or None,
                source="import",
                is_win=pnl > 0,
                duration_minutes=compute_duration(open_time, close_time),
            )
            db.add(trade)
            imported += 1
        except Exception as exc:
            errors.append(f"Row {i}: {exc}")

    db.commit()
    return {"imported": imported, "errors": errors}


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


