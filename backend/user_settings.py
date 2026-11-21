"""
User settings: the exchanges a user trades on, plus OPTIONAL fees per exchange.

  GET /settings/exchanges   -> {"exchanges": [...]}  (empty list for a new user)
  PUT /settings/exchanges   -> replaces the whole list, returns it

Each exchange entry:
  name          required, 1-30 chars (e.g. "KCEX")
  enabled       bool, default True
  maker_fee_pct optional, 0-5 (percent per side), null = not set
  taker_fee_pct optional, 0-5 (percent per side), null = not set

Stored per user (one row, JSON text) so it follows the account across devices.
Fees are never required: null means "user did not set one".
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import Column, DateTime, ForeignKey, Integer, Text
from sqlalchemy.orm import Session

from auth import get_current_user
from database import Base, User, get_db

MAX_EXCHANGES = 20


class UserSettings(Base):
    __tablename__ = "user_settings"

    id             = Column(Integer, primary_key=True, autoincrement=True)
    user_id        = Column(Integer, ForeignKey("users.id"), nullable=False, unique=True, index=True)
    exchanges_json = Column(Text, nullable=False, default="[]")
    updated_at     = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class ExchangeItem(BaseModel):
    name: str = Field(..., min_length=1, max_length=30)
    enabled: bool = True
    maker_fee_pct: Optional[float] = Field(None, ge=0, le=5)
    taker_fee_pct: Optional[float] = Field(None, ge=0, le=5)

    @field_validator("name")
    @classmethod
    def _clean_name(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Exchange name cannot be blank")
        return v


class ExchangesBody(BaseModel):
    exchanges: list[ExchangeItem] = Field(default_factory=list, max_length=MAX_EXCHANGES)

    @field_validator("exchanges")
    @classmethod
    def _unique_names(cls, items: list[ExchangeItem]) -> list[ExchangeItem]:
        seen: set[str] = set()
        for it in items:
            key = it.name.casefold()
            if key in seen:
                raise ValueError(f"Duplicate exchange: {it.name}")
            seen.add(key)
        return items


router = APIRouter(prefix="/settings", tags=["Settings"])


def _load(row: Optional[UserSettings]) -> list[dict]:
    if row is None:
        return []
    try:
        data = json.loads(row.exchanges_json or "[]")
        return data if isinstance(data, list) else []
    except ValueError:
        return []


@router.get("/exchanges")
def get_exchanges(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    row = db.query(UserSettings).filter(UserSettings.user_id == user.id).first()
    return {"exchanges": _load(row)}


@router.put("/exchanges")
def put_exchanges(body: ExchangesBody, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    payload = json.dumps([e.model_dump() for e in body.exchanges])
    row = db.query(UserSettings).filter(UserSettings.user_id == user.id).first()
    if row is None:
        row = UserSettings(user_id=user.id, exchanges_json=payload)
        db.add(row)
    else:
        row.exchanges_json = payload
    db.commit()
    return {"exchanges": [e.model_dump() for e in body.exchanges]}
