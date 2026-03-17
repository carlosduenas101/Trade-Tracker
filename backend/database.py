"""
Database module.
SQLAlchemy + SQLite setup with the Trade ORM model and Pydantic schemas
used throughout the application.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    Integer,
    String,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from config import DATABASE_URL

# ---------------------------------------------------------------------------
# Engine & session factory
# ---------------------------------------------------------------------------

# Supabase/Heroku use postgres:// — SQLAlchemy 2.0 requires postgresql://
_db_url = DATABASE_URL.replace("postgres://", "postgresql://", 1) if DATABASE_URL.startswith("postgres://") else DATABASE_URL

if _db_url.startswith("sqlite"):
    _connect_args = {"check_same_thread": False}
else:
    _connect_args = {"sslmode": "require"}

engine = create_engine(_db_url, connect_args=_connect_args)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


# ---------------------------------------------------------------------------
# ORM base & Trade model
# ---------------------------------------------------------------------------


class Base(DeclarativeBase):
    pass


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


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class TradeBase(BaseModel):
    """Fields shared by create and update schemas."""

    symbol: str = Field(..., example="BTC/USDT")
    side: str = Field(..., example="long")
    entry_price: float = Field(..., gt=0)
    exit_price: float = Field(..., gt=0)
    quantity: float = Field(..., gt=0)
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
    entry_price: Optional[float] = Field(None, gt=0)
    exit_price: Optional[float] = Field(None, gt=0)
    quantity: Optional[float] = Field(None, gt=0)
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
    """Create all tables if they do not already exist."""
    Base.metadata.create_all(bind=engine)
