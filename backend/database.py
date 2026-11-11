"""
Database module.
SQLAlchemy + SQLite setup with the Trade ORM model and Pydantic schemas
used throughout the application.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, Field
from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    create_engine,
    inspect,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Session, relationship, sessionmaker
from sqlalchemy.pool import NullPool

from config import DATABASE_URL

# ---------------------------------------------------------------------------
# Engine & session factory
# ---------------------------------------------------------------------------

# Supabase/Heroku use postgres:// — SQLAlchemy 2.0 requires postgresql://
_db_url = DATABASE_URL.replace("postgres://", "postgresql://", 1) if DATABASE_URL.startswith("postgres://") else DATABASE_URL

if _db_url.startswith("sqlite"):
    _connect_args = {"check_same_thread": False}
    engine = create_engine(_db_url, connect_args=_connect_args)
else:
    # NullPool disables connection pooling — required for Neon serverless Postgres
    # which closes idle connections aggressively, causing SSL drop errors with pooling
    engine = create_engine(
        _db_url,
        poolclass=NullPool,
        connect_args={
            "sslmode": "require",
            "connect_timeout": 10,
        }
    )

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


# ---------------------------------------------------------------------------
# ORM base & Trade model
# ---------------------------------------------------------------------------


class Base(DeclarativeBase):
    pass


# ---------------------------------------------------------------------------
# User model
# ---------------------------------------------------------------------------


class User(Base):
    """Invite-only user. Created via POST /auth/users (requires ADMIN_SECRET)."""

    __tablename__ = "users"

    id             = Column(Integer, primary_key=True, autoincrement=True)
    username       = Column(String(50),  unique=True, nullable=False, index=True)
    email          = Column(String(255), unique=True, nullable=False)
    hashed_password= Column(String(255), nullable=False)
    is_active      = Column(Boolean, default=True,  nullable=False)
    is_admin       = Column(Boolean, default=False, nullable=False)
    created_at     = Column(DateTime, default=datetime.utcnow, nullable=False)



# ---------------------------------------------------------------------------
# Trade model
# ---------------------------------------------------------------------------


class Trade(Base):
    """
    Represents a single completed trade (one full open → close cycle).

    Fields
    ------
    id              Auto-increment primary key.
    symbol          Trading pair, e.g. "BTC/USDT".
    side            Direction — "buy"/"long" or "sell"/"short".
    entry_price     Price at which the position was opened.
    exit_price      Price at which the position was closed.
    quantity        Asset quantity traded.
    pnl             Realised profit / loss in quote currency (calculated).
    is_win          True when pnl > 0.
    open_time       UTC timestamp when the position was opened.
    close_time      UTC timestamp when the position was closed.
    duration_minutes
                    How long the trade was open (minutes).
    risk_reward     Optional manually-set or calculated R:R ratio.
    notes           Free-text annotation (optional).
    source          "manual" — entered by user, "api" — synced from KCEX.
    """

    __tablename__ = "trades"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    symbol = Column(String(20), nullable=False, index=True)
    side = Column(String(10), nullable=False)
    entry_price = Column(Float, nullable=False)
    exit_price = Column(Float, nullable=False)
    quantity = Column(Float, nullable=False)
    pnl = Column(Float, nullable=False, default=0.0)
    roe = Column(Float, nullable=True)
    is_win = Column(Boolean, nullable=False, default=False)
    open_time = Column(DateTime, nullable=False)
    close_time = Column(DateTime, nullable=False)
    duration_minutes = Column(Integer, nullable=False, default=0)
    risk_reward = Column(Float, nullable=True)
    leverage = Column(Float, nullable=True)
    notes = Column(String(1000), nullable=True)
    source = Column(String(10), nullable=False, default="manual")
    entries = Column(Integer, nullable=True, default=1)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)

    owner = relationship("User")


# ---------------------------------------------------------------------------
# Fund Pool models — investors, contributions, return ledger
# ---------------------------------------------------------------------------


class Investor(Base):
    """
    A fund-pool contributor. One investor can have many contributions.

    is_owner
        Marks the fund operator (me). Owner money is capital, not an
        investment: owner contributions never generate return_ledger rows
        and are excluded from every liability-side aggregate. At most one
        investor row may carry the flag (partial unique index below).
    """

    __tablename__ = "investors"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    name       = Column(String(100), nullable=False, index=True)
    contact    = Column(String(255), nullable=True)
    is_owner   = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    contributions = relationship("Contribution", back_populates="investor")

    # At most one owner: unique on is_owner, but only across the true rows.
    __table_args__ = (
        Index(
            "ux_investors_single_owner",
            "is_owner",
            unique=True,
            postgresql_where=text("is_owner"),
            sqlite_where=text("is_owner"),
        ),
    )


class Contribution(Base):
    """
    A single principal deposit into the fund pool.

    payout_type
        "monthly"  — investor is paid 5% of principal each month; principal
                     never changes. Each elapsed month creates one unpaid
                     return_ledger row.
        "compound" — returns roll into the balance (principal * 1.05^months);
                     nothing is owed until the investor withdraws, which
                     closes the contribution.
    status
        "active" | "withdrawn" — withdrawal is v1's only way to close.
    amount
        Positive for investors. OWNER rows may be negative: an owner
        withdrawal is a negative-amount contribution, so owner_capital_in is
        SUM(amount) net of withdrawals by construction. The DB check is
        `amount <> 0`; the > 0 rule for non-owners is enforced in the route
        (a CHECK cannot reach across to investors.is_owner).
    """

    __tablename__ = "contributions"

    id               = Column(Integer, primary_key=True, autoincrement=True)
    investor_id      = Column(Integer, ForeignKey("investors.id"), nullable=False, index=True)
    amount           = Column(Numeric(14, 2), nullable=False)
    date_contributed = Column(Date, nullable=False)
    payout_type      = Column(String(10), nullable=False)   # monthly | compound
    status           = Column(String(10), nullable=False, default="active", index=True)
    notes            = Column(String(1000), nullable=True)
    created_at       = Column(DateTime, default=datetime.utcnow, nullable=False)

    investor    = relationship("Investor", back_populates="contributions")
    ledger_rows = relationship("ReturnLedger", back_populates="contribution")


class ReturnLedger(Base):
    """
    One accrued return period for a contribution.

    Every active contribution gets one row per elapsed anniversary month.
    period_action decides what happened to that period's return:
      'paid'     — owed as cash (paid=False until marked paid; the balance
                   base is unchanged for the next period)
      'compound' — rolled into the balance (becomes the base for the next
                   period's return)
    Rows with paid=True are immutable — the cash moved. Unpaid rows are
    recomputed whenever an earlier period's action or the terms change.

    running_balance      balance BEFORE this period's action (the base its
                         return was computed from)
    post_action_balance  balance AFTER the action

    Amounts and balances are NUMERIC(14, 4), not (14, 2): a compounded chain
    generates sub-cent returns (3307.50 * 5% = 165.375) and rounding each
    period to cents before it becomes the next period's base drifts the
    balance away from principal * 1.05^n. Cents are a display concern —
    the frontend formats to 2dp.
    """

    __tablename__ = "return_ledger"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    contribution_id = Column(Integer, ForeignKey("contributions.id"), nullable=False, index=True)
    period_start    = Column(Date, nullable=False)
    period_end      = Column(Date, nullable=False)
    amount          = Column(Numeric(14, 4), nullable=False)
    period_action   = Column(String(10), nullable=False, default="paid")  # paid | compound
    running_balance = Column(Numeric(14, 4), nullable=True)
    post_action_balance = Column(Numeric(14, 4), nullable=True)
    paid            = Column(Boolean, nullable=False, default=False, index=True)
    paid_date       = Column(DateTime, nullable=True)
    # bank_transfer | crypto | cash | other — set when the row is marked paid
    payment_method  = Column(String(20), nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow, nullable=False)

    contribution = relationship("Contribution", back_populates="ledger_rows")


class EquitySnapshot(Base):
    """
    A manual reading of the total KCEX account value, with the liability
    split FROZEN as it stood at that moment.

    account_equity is entered by hand — never derived from the trade log.
    investor_balance_at / returns_owed_at / owner_equity_at are computed once,
    on insert, and never recomputed: replaying today's ledger against an old
    date would drift as periods accrue and rows get flipped, which would
    silently rewrite the growth history.

        owner_equity_at = account_equity - (investor_balance_at + returns_owed_at)
    """

    __tablename__ = "equity_snapshots"

    id                  = Column(Integer, primary_key=True, autoincrement=True)
    snapshot_date       = Column(Date, nullable=False, unique=True, index=True)
    account_equity      = Column(Numeric(14, 4), nullable=False)
    investor_balance_at = Column(Numeric(14, 4), nullable=False)
    returns_owed_at     = Column(Numeric(14, 4), nullable=False)
    owner_equity_at     = Column(Numeric(14, 4), nullable=False)
    note                = Column(String(500), nullable=True)
    created_at          = Column(DateTime, default=datetime.utcnow, nullable=False)


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# User Pydantic schemas
# ---------------------------------------------------------------------------


class UserCreate(BaseModel):
    username: str = Field(..., min_length=2, max_length=50)
    email: str    = Field(..., max_length=255)
    password: str = Field(..., min_length=6)
    is_admin: bool = False


class UserResponse(BaseModel):
    id: int
    username: str
    email: str
    is_active: bool
    is_admin: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


# ---------------------------------------------------------------------------
# Trade Pydantic schemas
# ---------------------------------------------------------------------------


class TradeBase(BaseModel):
    """Fields shared by create and update schemas."""

    symbol: str = Field(..., example="BTC/USDT")
    side: str = Field(..., example="long")
    entry_price: float = Field(..., ge=0)
    exit_price: float = Field(..., ge=0)
    quantity: float = Field(..., ge=0)
    pnl: float = Field(..., description="Realized PnL after fees, entered manually")
    roe: Optional[float] = Field(None, description="Return on Equity % entered manually")
    open_time: datetime
    close_time: datetime
    risk_reward: Optional[float] = Field(None, ge=0)
    leverage: Optional[float] = Field(None, ge=1)
    notes: Optional[str] = Field(None, max_length=1000)
    source: str = Field("manual", pattern="^(manual|api|import)$")
    entries: Optional[int] = Field(None, ge=1, description="Number of entries taken for this trade")


class TradeCreate(TradeBase):
    """Schema for POST /trades."""
    pass


class TradeUpdate(BaseModel):
    """Schema for PUT /trades/{id} — all fields optional."""

    symbol: Optional[str] = None
    side: Optional[str] = None
    entry_price: Optional[float] = Field(None, ge=0)
    exit_price: Optional[float] = Field(None, ge=0)
    quantity: Optional[float] = Field(None, ge=0)
    open_time: Optional[datetime] = None
    close_time: Optional[datetime] = None
    pnl: Optional[float] = None
    roe: Optional[float] = None
    risk_reward: Optional[float] = Field(None, ge=0)
    leverage: Optional[float] = Field(None, ge=1)
    notes: Optional[str] = Field(None, max_length=1000)
    source: Optional[str] = Field(None, pattern="^(manual|api|import)$")
    entries: Optional[int] = Field(None, ge=1)


class TradeResponse(TradeBase):
    """Schema returned in API responses — includes computed / DB fields."""

    id: int
    pnl: float
    roe: Optional[float]
    is_win: bool
    duration_minutes: int
    entries: Optional[int]

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Fund Pool Pydantic schemas
# ---------------------------------------------------------------------------


class InvestorCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    contact: Optional[str] = Field(None, max_length=255)
    is_owner: bool = False


class InvestorResponse(BaseModel):
    id: int
    name: str
    contact: Optional[str]
    is_owner: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class InvestorUpdate(BaseModel):
    """Schema for PATCH /fund-pool/investors/{id} — all fields optional."""

    name: Optional[str] = Field(None, min_length=1, max_length=100)
    contact: Optional[str] = Field(None, max_length=255)
    is_owner: Optional[bool] = None


class ContributionCreate(BaseModel):
    investor_id: int
    # No gt=0 here: owner rows may be negative (a capital withdrawal). The
    # route enforces amount > 0 for non-owner investors and amount != 0 for
    # everyone — it is the only layer that can see investors.is_owner.
    amount: float
    date_contributed: date
    payout_type: str = Field(..., pattern="^(monthly|compound)$")
    notes: Optional[str] = Field(None, max_length=1000)


class ContributionUpdate(BaseModel):
    """
    Schema for PATCH /fund-pool/contributions/{id} — all fields optional.
    Changing amount, date_contributed or payout_type regenerates the
    contribution's unpaid ledger rows (paid rows are never touched).
    Sign rules match ContributionCreate and are enforced in the route.
    """

    amount: Optional[float] = None
    date_contributed: Optional[date] = None
    payout_type: Optional[str] = Field(None, pattern="^(monthly|compound)$")
    notes: Optional[str] = Field(None, max_length=1000)


class MarkPaidRequest(BaseModel):
    payment_method: str = Field(..., pattern="^(bank_transfer|crypto|cash|other)$")
    # Optional override: marking a compound-action row paid flips it to 'paid'
    # (cash instead of letting it ride) and cascades a recompute forward.
    period_action: Optional[str] = Field(None, pattern="^(paid|compound)$")


class WithdrawRequest(BaseModel):
    payment_method: str = Field(..., pattern="^(bank_transfer|crypto|cash|other)$")


class SetActionRequest(BaseModel):
    period_action: str = Field(..., pattern="^(paid|compound)$")


class LedgerUpdate(BaseModel):
    """
    Schema for PATCH /fund-pool/ledger/{id} — general edit, all fields
    optional. Unlike mark-paid/set-action, this works on paid rows too
    (direct correction of amount, action, status, paid date, or method).
    """

    amount: Optional[float] = Field(None, gt=0)
    period_action: Optional[str] = Field(None, pattern="^(paid|compound)$")
    paid: Optional[bool] = None
    paid_date: Optional[datetime] = None
    payment_method: Optional[str] = Field(None, pattern="^(bank_transfer|crypto|cash|other)$")


class ContributionResponse(BaseModel):
    """Contribution joined with investor name plus computed return fields."""

    id: int
    investor_id: int
    investor_name: str
    investor_contact: Optional[str]
    investor_is_owner: bool
    amount: float
    date_contributed: date
    payout_type: str
    status: str
    notes: Optional[str]
    created_at: datetime
    # Computed on read (see fund_pool.py)
    months_elapsed: int
    current_owed_or_balance: float
    next_due_date: Optional[date]          # monthly + active only
    current_period_start: Optional[date]   # monthly + active only — anniversary(date_contributed, months_elapsed)
    oldest_unpaid_due_date: Optional[date] # period_end of the oldest unpaid row, if any
    unpaid_ledger_id: Optional[int]        # oldest unpaid ledger row (monthly)


class LedgerResponse(BaseModel):
    id: int
    contribution_id: int
    period_start: date
    period_end: date
    amount: float
    period_action: str
    running_balance: Optional[float]        # balance before this period's action
    post_action_balance: Optional[float]    # balance after this period's action
    paid: bool
    paid_date: Optional[datetime]
    payment_method: Optional[str]

    model_config = {"from_attributes": True}


class LedgerDetailResponse(BaseModel):
    """GET /fund-pool/contributions/{id}/ledger — header + full history."""

    contribution: ContributionResponse
    ledger: list[LedgerResponse]


class PoolSummaryResponse(BaseModel):
    total_pool: float               # active non-owner principal
    investor_balance: float         # active non-owner balances (compounding included)
    returns_owed: float             # unpaid 'paid'-action rows, non-owner
    total_liability: float          # investor_balance + returns_owed
    total_after_returns: float      # alias of total_liability, kept for the existing tile
    contributors_count: int         # excludes the owner
    total_paid_out: float
    owner_capital_in: float         # owner deposits net of owner withdrawals
    monthly_principal_base: float
    monthly_return_rate: float


class EquitySnapshotCreate(BaseModel):
    snapshot_date: date
    account_equity: float
    note: Optional[str] = Field(None, max_length=500)


class EquitySnapshotResponse(BaseModel):
    """
    A stored snapshot plus its time-weighted return against the previous one.

    period_return   r for (previous snapshot -> this one]; None on the first
                    snapshot and on any period skipped by the guard below.
    period_skipped  True when the previous snapshot's owner_equity was <= 0,
                    making r meaningless (division by zero or a negative base).
                    Such periods are dropped from the chained product.
    cumulative_return
                    prod(1 + r) - 1 across every non-skipped period up to and
                    including this snapshot.
    """

    id: int
    snapshot_date: date
    account_equity: float
    investor_balance_at: float
    returns_owed_at: float
    total_liability_at: float
    owner_equity_at: float
    note: Optional[str]
    created_at: datetime
    net_owner_flow: float
    period_return: Optional[float]
    period_skipped: bool
    cumulative_return: Optional[float]


class OwnerSummaryResponse(BaseModel):
    """
    GET /fund-pool/owner-summary — the owner-equity tiles.

    account_equity / snapshot_date come from the most recent snapshot (manual
    entry is the only source). The liability figures are LIVE, so the tile
    shows equity as it stands right now, not as of the last snapshot — if
    returns have accrued since, owner_equity falls and can go negative.
    Returns are read from the stored snapshot chain and never recomputed.
    """

    account_equity: Optional[float]
    snapshot_date: Optional[date]
    is_stale: bool                  # last snapshot older than SNAPSHOT_STALE_DAYS
    investor_balance: float
    returns_owed: float
    total_liability: float
    owner_equity: Optional[float]
    owner_capital_in: float
    period_return: Optional[float]
    cumulative_return: Optional[float]
    break_even_account_return: Optional[float]


class EquitySlice(BaseModel):
    """One wedge of the composition ring. `value` is never negative."""

    label: str
    value: float
    share: float        # value / sum of all emitted slice values
    is_owner: bool


class EquityCompositionResponse(BaseModel):
    """
    GET /fund-pool/equity-composition — the donut, re-based from capital
    contributed onto claim-on-account-equity.

    mode
        'solvent'  account equity exceeds the liability; the ring is the
                   account, and one owner slice holds the remainder.
        'deficit'  liabilities exceed the account. No owner slice is emitted
                   — there is no positive owner claim — and a synthetic
                   'Deficit' slice carries the shortfall.
        'unknown'  no snapshot on file, so solvency is undecidable.
                   account_equity is None and slices is empty; render an
                   empty state rather than inventing a total.

    share always divides by the sum of the emitted slice values, so shares
    total 1.0 and the ring closes in every mode.
    """

    mode: str
    account_equity: Optional[float]
    snapshot_date: Optional[date]
    is_stale: bool
    slices: list[EquitySlice]
    deficit_amount: Optional[float]   # None unless mode == 'deficit'
    total_liability: float


class GrowthPoint(BaseModel):
    date: date
    pool_value: float
    benchmark_value: float
    projected: bool


class GrowthResponse(BaseModel):
    points: list[GrowthPoint]
    savings_apy: float


# ---------------------------------------------------------------------------
# Dependency — yields a DB session and ensures it is closed afterwards
# ---------------------------------------------------------------------------


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Helper utilities
# ---------------------------------------------------------------------------


def compute_pnl(side: str, entry_price: float, exit_price: float, quantity: float) -> float:
    """
    Calculate realised PnL for a closed trade.

    For long/buy positions:  pnl = (exit - entry) * quantity
    For short/sell positions: pnl = (entry - exit) * quantity
    """
    side_lower = side.lower()
    if side_lower in ("buy", "long"):
        return round((exit_price - entry_price) * quantity, 8)
    # sell / short
    return round((entry_price - exit_price) * quantity, 8)


def compute_duration(open_time: datetime, close_time: datetime) -> int:
    """Return trade duration in whole minutes (always >= 0)."""
    delta = close_time - open_time
    return max(0, int(delta.total_seconds() / 60))


def init_db() -> None:
    """Create all tables if they do not already exist, then apply migrations."""
    Base.metadata.create_all(bind=engine)
    _migrate()


def _migrate() -> None:
    """Add columns introduced after initial deploy (safe to run multiple times)."""
    import logging
    insp = inspect(engine)
    tables = insp.get_table_names()

    if "trades" in tables:
        existing_cols = {c["name"] for c in insp.get_columns("trades")}
        with engine.begin() as conn:
            if "user_id" not in existing_cols:
                logging.info("Migration: adding user_id column to trades")
                conn.execute(text(
                    "ALTER TABLE trades ADD COLUMN user_id INTEGER REFERENCES users(id)"
                ))

    if "return_ledger" in tables:
        existing_cols = {c["name"] for c in insp.get_columns("return_ledger")}
        with engine.begin() as conn:
            if "payment_method" not in existing_cols:
                logging.info("Migration: adding payment_method column to return_ledger")
                conn.execute(text(
                    "ALTER TABLE return_ledger ADD COLUMN payment_method VARCHAR(20)"
                ))
            if "period_action" not in existing_cols:
                logging.info("Migration: adding period_action column to return_ledger")
                conn.execute(text(
                    "ALTER TABLE return_ledger ADD COLUMN period_action VARCHAR(10) NOT NULL DEFAULT 'paid'"
                ))
            if "post_action_balance" not in existing_cols:
                logging.info("Migration: adding post_action_balance column to return_ledger")
                conn.execute(text(
                    "ALTER TABLE return_ledger ADD COLUMN post_action_balance NUMERIC(14, 2)"
                ))

    # --- Migration 004 — owner flag, 4dp ledger, negative owner amounts ---
    # Postgres-only DDL (ALTER COLUMN TYPE / DROP CONSTRAINT); the SQLite dev
    # fallback and the test DB get all of this from create_all() instead.
    is_postgres = engine.dialect.name == "postgresql"

    if "investors" in tables:
        existing_cols = {c["name"] for c in insp.get_columns("investors")}
        with engine.begin() as conn:
            if "is_owner" not in existing_cols:
                logging.info("Migration: adding is_owner column to investors")
                conn.execute(text(
                    "ALTER TABLE investors ADD COLUMN is_owner BOOLEAN NOT NULL DEFAULT FALSE"
                ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_investors_single_owner "
                "ON investors (is_owner) WHERE is_owner"
            ))

    if is_postgres and "return_ledger" in tables:
        # Sub-cent precision: a compounded chain generates returns like
        # 165.375, and rounding to cents before compounding drifts the balance.
        ledger_cols = {c["name"]: c for c in insp.get_columns("return_ledger")}
        with engine.begin() as conn:
            for col in ("amount", "running_balance", "post_action_balance"):
                spec = ledger_cols.get(col)
                if spec is not None and getattr(spec["type"], "scale", None) == 2:
                    logging.info("Migration: widening return_ledger.%s to NUMERIC(14, 4)", col)
                    conn.execute(text(
                        f"ALTER TABLE return_ledger ALTER COLUMN {col} TYPE NUMERIC(14, 4)"
                    ))

    if is_postgres and "contributions" in tables:
        # Owner withdrawals are negative-amount rows, so amount > 0 becomes
        # amount <> 0. The > 0 rule for non-owners lives in the route, which
        # is the only layer that can see investors.is_owner.
        with engine.begin() as conn:
            conn.execute(text(
                "ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_amount_check"
            ))
            conn.execute(text(
                "ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_amount_nonzero"
            ))
            conn.execute(text(
                "ALTER TABLE contributions "
                "ADD CONSTRAINT contributions_amount_nonzero CHECK (amount <> 0)"
            ))
