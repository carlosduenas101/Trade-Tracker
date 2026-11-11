"""
Authentication utilities — JWT creation/verification and bcrypt password hashing.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta
from typing import Optional

import bcrypt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from database import User, get_db

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SECRET_KEY = os.environ.get("SECRET_KEY", "CHANGE_ME_set_a_long_random_secret_in_env")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7

# Used to create/deactivate users — must be set in environment
ADMIN_SECRET = os.environ.get("ADMIN_SECRET", "")

# ---------------------------------------------------------------------------
# Password hashing (direct bcrypt — avoids passlib 1.7/bcrypt 4.x conflict)
# ---------------------------------------------------------------------------


# bcrypt only uses the first 72 bytes of a password. bcrypt >= 4.1 raises a
# ValueError on longer input instead of silently truncating like older versions
# (and passlib) did. We truncate to 72 bytes here to preserve that historical
# behaviour — otherwise long passwords would 500 the login endpoint.
_BCRYPT_MAX_BYTES = 72


def _truncate(plain: str) -> bytes:
    return plain.encode("utf-8")[:_BCRYPT_MAX_BYTES]


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(_truncate(plain), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_truncate(plain), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        # Malformed/legacy hash — fail closed rather than 500 the request.
        return False


# ---------------------------------------------------------------------------
# JWT
# ---------------------------------------------------------------------------

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


def create_access_token(user_id: int, username: str) -> str:
    expire = datetime.utcnow() + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    payload = {"sub": str(user_id), "username": username, "exp": expire}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Dependency — resolves the Bearer token to an active User ORM object."""
    exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired session. Please sign in again.",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: Optional[str] = payload.get("sub")
        if user_id is None:
            raise exc
    except JWTError:
        raise exc

    user = db.query(User).filter(
        User.id == int(user_id),
        User.is_active == True,
    ).first()
    if not user:
        raise exc
    return user


def require_admin_secret(request: Request) -> None:
    """Dependency — gate for user-management endpoints."""
    if not ADMIN_SECRET:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ADMIN_SECRET environment variable is not set on the server.",
        )
    secret = request.headers.get("x-admin-secret", "")
    if secret != ADMIN_SECRET:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid admin secret.",
        )


# ---------------------------------------------------------------------------
# Fund pool access — only one account (POOL_OWNER_USER_ID) may see or touch it
# ---------------------------------------------------------------------------


def pool_owner_id() -> Optional[int]:
    """Server-side id of the only account allowed into the fund pool.

    Read from the environment on every call so a missing/invalid value always
    means deny-all (never a crash, never a fallback to "any logged-in user").
    """
    raw = os.environ.get("POOL_OWNER_USER_ID", "").strip()
    try:
        return int(raw) if raw else None
    except ValueError:
        return None


def require_pool_owner(current_user: User = Depends(get_current_user)) -> User:
    """Dependency for every /fund-pool route: 401 if not logged in, 403 unless owner."""
    owner = pool_owner_id()
    if owner is None or current_user.id != owner:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden.")
    return current_user
