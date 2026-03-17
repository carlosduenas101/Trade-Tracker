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
from sqlalchemy import or_
from sqlalchemy.orm import Session

import config
from auth import (
    create_access_token,
    get_current_user,
    hash_password,
    require_admin_secret,
    verify_password,
)
from database import (
    LoginRequest,
    SessionLocal,
    TokenResponse,
    Trade,
    TradeCreate,
    TradeResponse,
    TradeUpdate,
    User,
    UserCreate,
    UserResponse,
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
# Auth routes
# ---------------------------------------------------------------------------


@app.post("/auth/login", response_model=TokenResponse, tags=["Auth"])
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    """Exchange username + password for a JWT access token."""
    user = db.query(User).filter(User.username == payload.username).first()
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password.",
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account has been deactivated.",
        )
    token = create_access_token(user.id, user.username)
    return {"access_token": token, "token_type": "bearer", "user": user}


@app.get("/auth/me", response_model=UserResponse, tags=["Auth"])
def me(current_user: User = Depends(get_current_user)):
    """Return the authenticated user's profile."""
    return current_user


@app.post("/auth/users", status_code=201, tags=["Auth"])
def create_user(
    payload: UserCreate,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin_secret),
):
    """
    Create an invited user.
    Requires the X-Admin-Secret header to match the ADMIN_SECRET env var.
    """
    # --- DIAGNOSTIC PROBE ---
    import sys, traceback as _tb
    probe = {}
    try:
        import bcrypt as _bcrypt
        probe["bcrypt_version"] = getattr(_bcrypt, "__version__", "?")
        probe["hash_test"] = _bcrypt.hashpw(b"test", _bcrypt.gensalt()).decode()[:20]
    except Exception as _e:
        probe["bcrypt_error"] = f"{type(_e).__name__}: {_e}\n{_tb.format_exc()}"
    try:
        probe["db_ok"] = db.execute(__import__("sqlalchemy").text("SELECT 1")).scalar() == 1
    except Exception as _e:
        probe["db_error"] = str(_e)
    return {"probe": probe, "payload": payload.model_dump(exclude={"password"})}
    # --- END DIAGNOSTIC ---
    try:
        existing = db.query(User).filter(
            (User.username == payload.username) | (User.email == payload.email)
        ).first()
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Username or email already exists.",
            )
        user = User(
            username=payload.username,
            email=payload.email,
            hashed_password=hash_password(payload.password),
            is_admin=payload.is_admin,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    except HTTPException:
        raise
    except Exception as exc:
        import traceback
        raise HTTPException(status_code=500, detail=f"DEBUG: {type(exc).__name__}: {exc}\n{traceback.format_exc()}")
    # Return plain dict to avoid ORM serialization issues
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "is_active": user.is_active,
        "is_admin": user.is_admin,
        "created_at": str(user.created_at),
    }


@app.get("/auth/users", response_model=list[UserResponse], tags=["Auth"])
def list_users(
    db: Session = Depends(get_db),
    _: None = Depends(require_admin_secret),
):
    """List all users (admin only)."""
    return db.query(User).order_by(User.created_at.asc()).all()


@app.patch("/auth/users/{user_id}", response_model=UserResponse, tags=["Auth"])
def toggle_user(
    user_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin_secret),
):
    """Toggle a user's is_active flag (activate / deactivate)."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    user.is_active = not user.is_active
    db.commit()
    db.refresh(user)
    return user


@app.post("/admin/claim-trades", tags=["Auth"])
def claim_orphaned_trades(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Assign all trades that have no owner (legacy data) to the calling user.
    Call this once after your first login to reclaim pre-auth trades.
    """
    updated = db.query(Trade).filter(Trade.user_id == None).update(
        {"user_id": current_user.id}, synchronize_session=False
    )
    db.commit()
    return {"claimed": updated}


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
    start_date: Optional[datetime] = Query(None, example="2024-01-01T00:00:00"),
    end_date:   Optional[datetime] = Query(None, example="2024-12-31T23:59:59"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[Trade]:
    """Return the authenticated user's trades, oldest-first."""
    query = db.query(Trade).filter(
        or_(Trade.user_id == current_user.id, Trade.user_id == None)
    ).order_by(Trade.close_time.asc())
    query = _apply_date_filters(query, start_date, end_date)
    return query.all()


# ---------------------------------------------------------------------------
# POST /trades
# ---------------------------------------------------------------------------


@app.post("/trades", response_model=TradeResponse, status_code=status.HTTP_201_CREATED, tags=["Trades"])
def create_trade(
    payload: TradeCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Trade:
    """Manually add a single completed trade."""
    if payload.close_time <= payload.open_time:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="close_time must be after open_time.",
        )
    fields = _trade_from_create(payload)
    trade = Trade(**fields, user_id=current_user.id)
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
    current_user: User = Depends(get_current_user),
) -> Trade:
    """Edit an existing trade by ID (must belong to the calling user)."""
    trade = db.query(Trade).filter(
        Trade.id == trade_id,
        or_(Trade.user_id == current_user.id, Trade.user_id == None),
    ).first()
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
def delete_trade(
    trade_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    """Delete a trade by ID (must belong to the calling user)."""
    trade = db.query(Trade).filter(
        Trade.id == trade_id,
        or_(Trade.user_id == current_user.id, Trade.user_id == None),
    ).first()
    if not trade:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Trade not found.")
    db.delete(trade)
    db.commit()


# ---------------------------------------------------------------------------
# DELETE /trades/bulk
# ---------------------------------------------------------------------------

from pydantic import BaseModel as _BaseModel

class BulkDeleteRequest(_BaseModel):
    ids: list[int]

@app.post("/trades/bulk-delete", status_code=status.HTTP_200_OK, tags=["Trades"])
def bulk_delete_trades(
    payload: BulkDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete multiple trades by ID list (only trades owned by the calling user)."""
    deleted = db.query(Trade).filter(
        Trade.id.in_(payload.ids),
        or_(Trade.user_id == current_user.id, Trade.user_id == None),
    ).delete(synchronize_session=False)
    db.commit()
    return {"deleted": deleted}


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
    """Lowercase + strip keys, apply aliases, strip values."""
    return {
        _COL_ALIASES.get(k.strip().lower(), k.strip().lower()): (v or '').strip()
        for k, v in row.items()
        if k is not None
    }


def _parse_float(val: str):
    if not val:
        return None
    try:
        # Remove thousands separators and currency symbols
        cleaned = val.replace(',', '').replace('$', '').replace('%', '').strip()
        return float(cleaned) if cleaned else None
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
async def import_trades(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Bulk import trades from a CSV file.
    Download /trades/template for the expected column format.
    """
    content = await file.read()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")

    # Auto-detect delimiter by trying each until headers make sense
    _required = {"symbol", "pnl", "open_time", "close_time"}
    delimiter = ','
    for _delim in ['\t', ',', ';', '|']:
        _reader = csv.DictReader(io.StringIO(text), delimiter=_delim)
        _headers = {(h or '').strip().lower() for h in (_reader.fieldnames or [])}
        if _required.issubset(_headers):
            delimiter = _delim
            break
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

            # entry/exit price optional — default to 0 if not in export
            entry_price = entry_price or 0.0
            exit_price  = exit_price  or 0.0

            missing = [f for f, v in [
                ("symbol", symbol), ("side", side),
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
                user_id=current_user.id,
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
    start_date: Optional[datetime] = Query(None, example="2024-01-01T00:00:00"),
    end_date:   Optional[datetime] = Query(None, example="2024-12-31T23:59:59"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Return performance metrics for the authenticated user's trades."""
    query = db.query(Trade).filter(
        or_(Trade.user_id == current_user.id, Trade.user_id == None)
    ).order_by(Trade.close_time.asc())
    query = _apply_date_filters(query, start_date, end_date)
    trades = query.all()
    return get_all_metrics(trades)


