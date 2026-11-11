"""
FastAPI application entry point.

Routes
------
GET    /trades          List all trades (filters: ?start_date= &end_date=)
POST   /trades          Manually add a trade
PUT    /trades/{id}     Edit an existing trade
DELETE /trades/{id}     Delete a trade
GET    /metrics         Performance metrics (filters: ?start_date= &end_date=)

Fund Pool (investor returns tracker — see fund_pool.py for the payout modes)
POST   /fund-pool/investors                    Create (or fetch by name) an investor (is_owner optional)
PATCH  /fund-pool/investors/{id}               Edit investor name/contact/is_owner
POST   /fund-pool/contributions                Add a contribution
GET    /fund-pool/contributions                List with computed owed/balance fields
PATCH  /fund-pool/contributions/{id}           Edit terms (regenerates unpaid ledger)
GET    /fund-pool/contributions/{id}/ledger    Full payment history for one contribution
PATCH  /fund-pool/ledger/{id}/mark-paid        Settle one return as cash (payment_method required;
                                               optional period_action='paid' override for compound rows)
PATCH  /fund-pool/ledger/{id}/set-action       Flip an unpaid period paid/compound (cascades recompute)
POST   /fund-pool/contributions/{id}/withdraw  Close a compound contribution (payment_method required)
GET    /fund-pool/summary                      Pool totals for the dashboard tiles

Owner equity (what is left after the fund's obligations — see fund_pool.py)
POST   /fund-pool/equity-snapshots             Record account equity; freezes the liability split
GET    /fund-pool/equity-snapshots             Snapshot history with time-weighted returns
DELETE /fund-pool/equity-snapshots/{id}        Remove a snapshot (chain re-links across the gap)
GET    /fund-pool/owner-summary                Account equity vs liability, owner equity, TWR growth
GET    /fund-pool/equity-composition           Donut slices: each investor's claim + my equity (or the deficit)

Run with:
    uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import csv
import io
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import or_
from sqlalchemy.orm import Session

import config
from auth import (
    create_access_token,
    get_current_user,
    hash_password,
    pool_owner_id,
    require_admin_secret,
    require_pool_owner,
    verify_password,
)
from database import (
    Contribution,
    ContributionCreate,
    ContributionResponse,
    ContributionUpdate,
    EquitySnapshot,
    EquityCompositionResponse,
    EquitySnapshotCreate,
    EquitySnapshotResponse,
    Investor,
    InvestorCreate,
    InvestorResponse,
    InvestorUpdate,
    LedgerDetailResponse,
    LedgerResponse,
    LedgerUpdate,
    LoginRequest,
    MarkPaidRequest,
    OwnerSummaryResponse,
    SetActionRequest,
    WithdrawRequest,
    PoolSummaryResponse,
    GrowthResponse,
    ReturnLedger,
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
from metrics import get_all_metrics, calculate_period_averages
import fund_pool
from market import router as market_router
import paper  # paper trading tables + engine (imported before init_db so its tables are created)

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

# Compress large JSON responses (historical candles for the ladder simulation)
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Market data routes — registered before the frontend catch-all route below
app.include_router(market_router)
app.include_router(paper.router)


@app.on_event("startup")
def on_startup() -> None:
    """Initialise database tables on first run."""
    import logging
    db_type = "sqlite" if config.DATABASE_URL.startswith("sqlite") else "postgresql"
    logging.info(f"Connecting to database type: {db_type}")
    try:
        init_db()
        logging.info("Database initialised successfully.")
        paper.start_engine()
        if pool_owner_id() is None:
            logging.error(
                "POOL_OWNER_USER_ID is missing or not an integer: the fund pool is "
                "locked for EVERY user (deny by default). Set it to the owner's user id."
            )
    except Exception as exc:
        logging.error(f"Database init failed: {exc}")
        raise


# ---------------------------------------------------------------------------
# Frontend path (resolved once at startup)
# ---------------------------------------------------------------------------

_frontend = Path(__file__).resolve().parent.parent / "frontend"


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
    """Apply optional date range filters to a SQLAlchemy query on Trade.

    When end_date arrives with no time component (i.e. parsed from a plain
    date string like '2026-03-23') it lands at 00:00:00, which would silently
    exclude every trade that closed later that same day.  We expand it to
    end-of-day so the full calendar day is always included.
    """
    if start_date:
        query = query.filter(Trade.close_time >= start_date)
    if end_date:
        if end_date.hour == 0 and end_date.minute == 0 and end_date.second == 0:
            end_date = end_date.replace(hour=23, minute=59, second=59)
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
    "qty": "quantity", "size": "quantity", "amount": "quantity",
    "contracts": "quantity", "volume": "quantity",
    "rr": "risk_reward",
    "open_date": "open_time", "close_date": "close_time",
    "open": "open_time", "close": "close_time",
    "profit": "pnl", "profit_loss": "pnl", "realized_pnl": "pnl",
    "realized_profit": "pnl", "net_profit": "pnl",
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
    if not val:
        return None
    try:
        return int(val)
    except ValueError:
        try:
            return int(float(val))  # handles "1.0", "2.0", etc.
        except (ValueError, TypeError):
            return None


_DT_FORMATS = [
    "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M",    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%m/%d/%Y",
    "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y",
    # Excel AM/PM formats
    "%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y %I:%M %p",
    "%d/%m/%Y %I:%M:%S %p", "%d/%m/%Y %I:%M %p",
    "%Y-%m-%d %I:%M:%S %p", "%Y-%m-%d %I:%M %p",
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
    Each row is committed independently so one bad row never blocks the others.
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
    skipped = 0
    errors = []

    _side_aliases = {"buy": "long", "sell": "short"}

    for i, raw_row in enumerate(reader, start=2):  # row 1 is header
        # Skip completely blank rows
        if not any((v or '').strip() for v in raw_row.values()):
            continue

        row = _normalise_row(raw_row)
        try:
            symbol = row.get("symbol", "").upper()
            side_raw = row.get("side", "").lower()
            side = _side_aliases.get(side_raw, side_raw)
            entry_price = _parse_float(row.get("entry_price", "")) or 0.0
            exit_price  = _parse_float(row.get("exit_price",  "")) or 0.0
            quantity    = _parse_float(row.get("quantity", "")) or 0.0
            pnl         = _parse_float(row.get("pnl", ""))
            open_time   = _parse_dt(row.get("open_time",  ""))
            close_time  = _parse_dt(row.get("close_time", ""))

            # Validate required fields — include raw value so user knows what failed
            missing = []
            if not symbol:
                missing.append(f"symbol={repr(row.get('symbol', ''))}")
            if not side:
                missing.append(f"side={repr(row.get('side', ''))}")
            if pnl is None:
                missing.append(f"pnl={repr(row.get('pnl', ''))}")
            if open_time is None:
                missing.append(f"open_time={repr(row.get('open_time', ''))}")
            if close_time is None:
                missing.append(f"close_time={repr(row.get('close_time', ''))}")
            if missing:
                errors.append(f"Row {i}: missing/unparseable — {'; '.join(missing)}")
                continue

            if close_time <= open_time:
                errors.append(f"Row {i}: close_time ({close_time}) must be after open_time ({open_time})")
                continue

            # Duplicate detection: same user + symbol + open_time + close_time + pnl
            duplicate = db.query(Trade).filter(
                or_(Trade.user_id == current_user.id, Trade.user_id == None),
                Trade.symbol == symbol,
                Trade.open_time == open_time,
                Trade.close_time == close_time,
                Trade.pnl == pnl,
            ).first()
            if duplicate:
                skipped += 1
                errors.append(f"Row {i}: duplicate — trade already exists (id={duplicate.id})")
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
            # Commit each row independently so one failure never blocks others
            db.add(trade)
            db.commit()
            db.refresh(trade)
            imported += 1
        except Exception as exc:
            db.rollback()
            errors.append(f"Row {i}: {exc}")

    return {"imported": imported, "skipped": skipped, "errors": errors}


# ---------------------------------------------------------------------------
# GET /export  — download user's trades as CSV (same format as template)
# ---------------------------------------------------------------------------


@app.get("/export", tags=["Trades"])
def export_trades(
    start_date: Optional[datetime] = Query(None, example="2024-01-01T00:00:00"),
    end_date:   Optional[datetime] = Query(None, example="2024-12-31T23:59:59"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Export the authenticated user's trades as a CSV file (template-compatible format)."""
    query = db.query(Trade).filter(
        or_(Trade.user_id == current_user.id, Trade.user_id == None)
    ).order_by(Trade.close_time.asc())
    query = _apply_date_filters(query, start_date, end_date)
    trades = query.all()

    def _fmt(val):
        if val is None:
            return ""
        if isinstance(val, datetime):
            return val.strftime("%Y-%m-%dT%H:%M:%S")
        return str(val)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(_CSV_COLUMNS)
    for t in trades:
        writer.writerow([
            _fmt(t.symbol),
            _fmt(t.side),
            _fmt(t.entry_price),
            _fmt(t.exit_price),
            _fmt(t.quantity),
            _fmt(t.pnl),
            _fmt(t.roe),
            _fmt(t.leverage),
            _fmt(t.risk_reward),
            _fmt(t.entries),
            _fmt(t.open_time),
            _fmt(t.close_time),
            _fmt(t.notes),
        ])
    output.seek(0)
    filename = f"trades_export_{datetime.utcnow().strftime('%Y-%m-%d')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


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
    base_query = db.query(Trade).filter(
        or_(Trade.user_id == current_user.id, Trade.user_id == None)
    ).order_by(Trade.close_time.asc())

    trades = _apply_date_filters(base_query, start_date, end_date).all()
    result = get_all_metrics(trades)

    # Daily/weekly/monthly averages respect the same start/end date filter
    # as the rest of the metrics, so switching 7/30/90/all updates these too.
    result.update(calculate_period_averages(trades))
    return result


# ---------------------------------------------------------------------------
# Fund Pool — persisted investor-returns tracker
# ---------------------------------------------------------------------------


def _assert_no_other_owner(db: Session, investor_id: Optional[int] = None) -> None:
    """409 if another investor already carries the owner flag."""
    q = db.query(Investor).filter(Investor.is_owner == True)  # noqa: E712
    if investor_id is not None:
        q = q.filter(Investor.id != investor_id)
    if q.first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Another investor is already marked as the owner.",
        )


def _validate_amount(amount: float, investor: Investor) -> None:
    """
    Sign rules for a contribution amount.

    Owner rows may be negative — that is how a capital withdrawal is recorded,
    so owner_capital_in stays a plain SUM. Investor rows must be positive.
    Zero is meaningless either way. This lives in the route because it is the
    only layer that can see investors.is_owner; the DB check is amount <> 0.
    """
    if amount == 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Amount cannot be zero.",
        )
    if amount < 0 and not investor.is_owner:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Only the owner can record a negative amount (a capital withdrawal).",
        )


@app.post("/fund-pool/investors", response_model=InvestorResponse,
          status_code=status.HTTP_201_CREATED, tags=["Fund Pool"])
def create_investor(
    payload: InvestorCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
) -> Investor:
    """
    Create an investor. Idempotent by name (case-insensitive): adding a
    contribution for an existing name reuses that investor instead of
    creating a duplicate.

    is_owner marks the fund operator. At most one investor may hold it —
    the DB enforces this with a partial unique index; the check here turns
    the race into a 409 instead of an IntegrityError.
    """
    name = payload.name.strip()
    existing = db.query(Investor).filter(
        Investor.name.ilike(name)
    ).first()
    if existing:
        return existing
    if payload.is_owner:
        _assert_no_other_owner(db)
    investor = Investor(name=name, contact=payload.contact, is_owner=payload.is_owner)
    db.add(investor)
    db.commit()
    db.refresh(investor)
    return investor


@app.patch("/fund-pool/investors/{investor_id}", response_model=InvestorResponse,
           tags=["Fund Pool"])
def update_investor(
    investor_id: int,
    payload: InvestorUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
) -> Investor:
    """Edit an investor's name and/or contact."""
    investor = db.query(Investor).filter(Investor.id == investor_id).first()
    if not investor:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Investor not found.")

    update_data = payload.model_dump(exclude_unset=True)
    if "name" in update_data:
        name = update_data["name"].strip()
        clash = db.query(Investor).filter(
            Investor.name.ilike(name), Investor.id != investor_id
        ).first()
        if clash:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Another investor already has that name.",
            )
        update_data["name"] = name
    if update_data.get("is_owner"):
        _assert_no_other_owner(db, investor_id)
        # Promoting an investor to owner would strand any ledger rows they
        # already accrued: owner money never accrues, so those rows would sit
        # outside every aggregate.
        accrued = (
            db.query(ReturnLedger)
            .join(Contribution, ReturnLedger.contribution_id == Contribution.id)
            .filter(Contribution.investor_id == investor_id)
            .first()
        )
        if accrued:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Cannot mark an investor with accrued returns as the owner.",
            )
    for field, value in update_data.items():
        setattr(investor, field, value)
    db.commit()
    db.refresh(investor)
    return investor


@app.post("/fund-pool/contributions", response_model=ContributionResponse,
          status_code=status.HTTP_201_CREATED, tags=["Fund Pool"])
def create_contribution(
    payload: ContributionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
):
    """
    Add a principal contribution for an existing investor.

    A negative amount is valid only for the owner, where it records a capital
    withdrawal (see _validate_amount).
    """
    investor = db.query(Investor).filter(Investor.id == payload.investor_id).first()
    if not investor:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Investor not found.")
    _validate_amount(payload.amount, investor)
    contribution = Contribution(
        investor_id=payload.investor_id,
        amount=payload.amount,
        date_contributed=payload.date_contributed,
        payout_type=payload.payout_type,
        notes=payload.notes,
    )
    db.add(contribution)
    db.commit()
    db.refresh(contribution)
    # Backfill any months already elapsed if date_contributed is in the past
    fund_pool.sync_ledger(db, contribution)
    db.commit()
    return fund_pool.contribution_to_response(db, contribution)


@app.get("/fund-pool/contributions", response_model=list[ContributionResponse],
         tags=["Fund Pool"])
def list_contributions(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
):
    """
    All contributions joined with investor name, plus computed fields:
    months_elapsed, current_owed_or_balance (unpaid returns for monthly,
    compounded balance for compound), next_due_date and the oldest unpaid
    ledger id (monthly only).
    """
    contributions = (
        db.query(Contribution)
        .join(Investor)
        .order_by(Contribution.date_contributed.asc(), Contribution.id.asc())
        .all()
    )
    # Materialise monthly ledger rows that came due since the last read
    for c in contributions:
        fund_pool.sync_ledger(db, c)
    db.commit()
    return [fund_pool.contribution_to_response(db, c) for c in contributions]


@app.patch("/fund-pool/contributions/{contribution_id}", response_model=ContributionResponse,
           tags=["Fund Pool"])
def update_contribution(
    contribution_id: int,
    payload: ContributionUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
):
    """
    Edit a contribution's amount, date_contributed and/or payout_type.

    Changing amount or date_contributed regenerates the unpaid ledger under
    the new terms (paid rows are never rewritten — they represent money that
    actually moved). Changing payout_type alone only alters the DEFAULT
    period_action for future periods; already-generated rows keep their
    per-period choice. Everything runs in one transaction: on failure nothing
    is persisted, so a partially regenerated ledger is impossible.
    """
    contribution = db.query(Contribution).filter(Contribution.id == contribution_id).first()
    if not contribution:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contribution not found.")
    if contribution.status != "active":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Withdrawn contributions cannot be edited.",
        )

    update_data = payload.model_dump(exclude_unset=True)
    if "amount" in update_data:
        _validate_amount(update_data["amount"], contribution.investor)
    needs_recompute = any(
        field in update_data and update_data[field] != getattr(contribution, field)
        for field in ("amount", "date_contributed")
    )

    try:
        for field, value in update_data.items():
            setattr(contribution, field, value)
        if needs_recompute:
            fund_pool.recompute_unpaid_ledger(db, contribution)
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(contribution)
    return fund_pool.contribution_to_response(db, contribution)


@app.get("/fund-pool/contributions/{contribution_id}/ledger",
         response_model=LedgerDetailResponse, tags=["Fund Pool"])
def get_contribution_ledger(
    contribution_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
):
    """Full return_ledger history for one contribution, plus its header info."""
    contribution = db.query(Contribution).filter(Contribution.id == contribution_id).first()
    if not contribution:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contribution not found.")
    fund_pool.sync_ledger(db, contribution)
    db.commit()
    rows = (
        db.query(ReturnLedger)
        .filter(ReturnLedger.contribution_id == contribution_id)
        .order_by(ReturnLedger.period_end.asc(), ReturnLedger.id.asc())
        .all()
    )
    return {
        "contribution": fund_pool.contribution_to_response(db, contribution),
        "ledger": rows,
    }


@app.patch("/fund-pool/ledger/{ledger_id}/mark-paid", response_model=LedgerResponse,
           tags=["Fund Pool"])
def mark_ledger_paid(
    ledger_id: int,
    payload: MarkPaidRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
) -> ReturnLedger:
    """
    Settle one return as cash: sets paid=True, paid_date and payment_method.

    If the row is currently period_action='compound' (the investor wants
    cash this time instead of letting it ride), pass period_action='paid'
    to flip it in the same call — this cascades a recompute through every
    later unpaid period, since the balance base changed. Once paid, a row
    is immutable; there is no un-pay in v1.
    """
    row = db.query(ReturnLedger).filter(ReturnLedger.id == ledger_id).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ledger entry not found.")
    if row.paid:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Ledger entry is already paid.")
    if row.period_action == "compound" and payload.period_action != "paid":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="This period is set to compound. Pass period_action='paid' to cash it out instead.",
        )
    try:
        if payload.period_action:
            row.period_action = payload.period_action
        # Recompute while the row is still unpaid so its own amount/balances
        # reflect the final action, then lock it — paid rows are immutable
        fund_pool.recompute_balances(db, row.contribution)
        row.paid = True
        row.paid_date = datetime.utcnow()
        row.payment_method = payload.payment_method
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(row)
    return row


@app.patch("/fund-pool/ledger/{ledger_id}", response_model=LedgerResponse,
           tags=["Fund Pool"])
def edit_ledger_row(
    ledger_id: int,
    payload: LedgerUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
) -> ReturnLedger:
    """
    General correction for one ledger row — amount, action, paid status,
    paid date, and payment method are all directly editable here (unlike
    mark-paid/set-action, this also works on already-paid rows). Recomputes
    the balance walk afterward since a changed amount/action/status shifts
    every later period's running balance.
    """
    row = db.query(ReturnLedger).filter(ReturnLedger.id == ledger_id).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ledger entry not found.")

    data = payload.model_dump(exclude_unset=True)
    becomes_paid = data.get("paid", row.paid)
    method_after = data["payment_method"] if "payment_method" in data else row.payment_method
    if becomes_paid and not method_after:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="payment_method is required to mark an entry paid.",
        )

    try:
        if "period_action" in data:
            row.period_action = data["period_action"]
        if "amount" in data:
            row.amount = Decimal(str(data["amount"]))
        if "payment_method" in data:
            row.payment_method = data["payment_method"]
        if "paid_date" in data:
            row.paid_date = data["paid_date"]
        if "paid" in data:
            row.paid = data["paid"]
            if row.paid and row.paid_date is None:
                row.paid_date = datetime.utcnow()
            if not row.paid and "paid_date" not in data:
                row.paid_date = None
                if "payment_method" not in data:
                    row.payment_method = None
        fund_pool.recompute_balances(db, row.contribution)
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(row)
    return row


@app.patch("/fund-pool/ledger/{ledger_id}/set-action", response_model=LedgerDetailResponse,
           tags=["Fund Pool"])
def set_ledger_action(
    ledger_id: int,
    payload: SetActionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
):
    """
    Flip an unpaid period between 'paid' and 'compound'. Cascades a recompute
    through every later unpaid period (the balance base changed) in one
    transaction. Paid rows are immutable — cash already moved.
    """
    row = db.query(ReturnLedger).filter(ReturnLedger.id == ledger_id).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ledger entry not found.")
    if row.paid:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This period is already paid out — its action is locked.",
        )
    try:
        fund_pool.set_period_action(db, row, payload.period_action)
        db.commit()
    except Exception:
        db.rollback()
        raise
    contribution = row.contribution
    rows = (
        db.query(ReturnLedger)
        .filter(ReturnLedger.contribution_id == contribution.id)
        .order_by(ReturnLedger.period_end.asc(), ReturnLedger.id.asc())
        .all()
    )
    return {
        "contribution": fund_pool.contribution_to_response(db, contribution),
        "ledger": rows,
    }


@app.post("/fund-pool/contributions/{contribution_id}/withdraw",
          response_model=ContributionResponse, tags=["Fund Pool"])
def withdraw_contribution(
    contribution_id: int,
    payload: WithdrawRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
):
    """
    Withdraw a compound contribution: pays out balance - principal in one
    paid ledger row (stamped with payment_method) and sets status='withdrawn'.
    Partial withdrawals are out of scope for v1 — this closes the contribution.
    """
    contribution = db.query(Contribution).filter(Contribution.id == contribution_id).first()
    if not contribution:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contribution not found.")
    if fund_pool.is_owner_contribution(contribution):
        # This path pays out balance - principal as a settled ledger row, which
        # would put owner money into total_paid_out and invent a return the
        # owner never accrued. Owner capital leaves as a negative contribution.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Owner capital is withdrawn by recording a negative contribution, not a payout.",
        )
    if contribution.payout_type != "compound":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Only compound contributions can be withdrawn.",
        )
    if contribution.status != "active":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Contribution is already withdrawn.")
    fund_pool.withdraw_contribution(db, contribution, payload.payment_method)
    db.commit()
    db.refresh(contribution)
    return fund_pool.contribution_to_response(db, contribution)


@app.get("/fund-pool/summary", response_model=PoolSummaryResponse, tags=["Fund Pool"])
def get_pool_summary(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
) -> dict:
    """Totals for the dashboard tiles — see fund_pool.pool_summary."""
    return fund_pool.pool_summary(db)


@app.get("/fund-pool/growth", response_model=GrowthResponse, tags=["Fund Pool"])
def get_pool_growth(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
) -> dict:
    """Monthly pool-value trend vs a flat-APY savings benchmark — see fund_pool.growth_series."""
    return fund_pool.growth_series(db)


# ---------------------------------------------------------------------------
# Fund Pool — owner equity
# ---------------------------------------------------------------------------


@app.post("/fund-pool/equity-snapshots", response_model=EquitySnapshotResponse,
          status_code=status.HTTP_201_CREATED, tags=["Fund Pool"])
def create_equity_snapshot(
    payload: EquitySnapshotCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
) -> dict:
    """
    Record the total account value on a date and freeze the liability split
    alongside it.

    account_equity is manual by design — it is never derived from the trade
    log. The derived fields are computed once, here, and stored: recomputing
    them later against a moved-on ledger would silently rewrite history.
    One snapshot per date.
    """
    account_equity = Decimal(str(payload.account_equity))
    existing = db.query(EquitySnapshot).filter(
        EquitySnapshot.snapshot_date == payload.snapshot_date
    ).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A snapshot already exists for {payload.snapshot_date}.",
        )

    derived = fund_pool.snapshot_derived_values(db, account_equity)
    snapshot = EquitySnapshot(
        snapshot_date=payload.snapshot_date,
        account_equity=account_equity,
        note=payload.note,
        **derived,
    )
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)
    # Return the row with its place in the chain filled in
    chain = fund_pool.list_equity_snapshots(db)
    return next(row for row in chain if row["id"] == snapshot.id)


@app.get("/fund-pool/equity-snapshots", response_model=list[EquitySnapshotResponse],
         tags=["Fund Pool"])
def list_equity_snapshots(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
) -> list[dict]:
    """
    Every snapshot oldest-first with its time-weighted period return and the
    chained cumulative return — see fund_pool.twr_chain.
    """
    return fund_pool.list_equity_snapshots(db)


@app.delete("/fund-pool/equity-snapshots/{snapshot_id}",
            status_code=status.HTTP_204_NO_CONTENT, tags=["Fund Pool"])
def delete_equity_snapshot(
    snapshot_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
) -> None:
    """
    Delete a snapshot. The TWR chain re-links across the gap on the next read
    (the surviving rows keep their own frozen values — nothing is recomputed).
    """
    snapshot = db.query(EquitySnapshot).filter(EquitySnapshot.id == snapshot_id).first()
    if not snapshot:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Snapshot not found.")
    db.delete(snapshot)
    db.commit()


@app.get("/fund-pool/owner-summary", response_model=OwnerSummaryResponse, tags=["Fund Pool"])
def get_owner_summary(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
) -> dict:
    """
    How much of the account is actually mine — see fund_pool.owner_summary.

    account_equity comes from the latest snapshot; the liability is live, so
    owner_equity reflects returns that have accrued since. It can be negative,
    and the response never clamps it.
    """
    return fund_pool.owner_summary(db)


@app.get("/fund-pool/equity-composition", response_model=EquityCompositionResponse,
         tags=["Fund Pool"])
def get_equity_composition(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_pool_owner),
) -> dict:
    """
    Who has a claim on the account, as ring slices — see
    fund_pool.equity_composition.

    Each investor is one slice (their compounded balance plus any unpaid cash
    return), and the remainder of the account is mine. When the liability
    exceeds the account there is no owner slice at all; a Deficit slice
    carries the shortfall instead.
    """
    return fund_pool.equity_composition(db)


# ---------------------------------------------------------------------------
# Serve frontend — catch-all LAST so every API route above takes priority.
# GET /           → index.html
# GET /style.css  → style.css  (FileResponse auto-sets Content-Type)
# GET /any/path   → index.html (SPA fallback)
# ---------------------------------------------------------------------------

@app.get("/{full_path:path}", include_in_schema=False)
async def serve_frontend(full_path: str):
    target = _frontend / full_path
    if target.is_file():
        return FileResponse(str(target))
    return FileResponse(str(_frontend / "index.html"))
