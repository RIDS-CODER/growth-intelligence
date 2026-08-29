"""Authentication.

Two modes behind one dependency:

* **Supabase** — when `SUPABASE_JWT_SECRET` is set, incoming tokens are verified as
  Supabase JWTs and the user is resolved (or provisioned) by `sub`.
* **Local JWT** — otherwise the app issues and verifies its own HS256 tokens, so
  development and self-hosting need no external identity provider.

Both paths end at the same `TenantContext`, so route code never knows which ran.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import base64
import hashlib

import bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models.tenancy import Client, Membership, User

bearer = HTTPBearer(auto_error=False)


def _prehash(password: str) -> bytes:
    """Reduce a password to a fixed 44-byte token before bcrypt.

    bcrypt silently truncates anything past 72 bytes, which would make two long
    passwords sharing a 72-byte prefix interchangeable. Hashing first means the
    whole password always contributes, and the base64 encoding keeps the result
    free of the NUL bytes bcrypt would otherwise treat as a terminator.
    """
    return base64.b64encode(hashlib.sha256(password.encode("utf-8")).digest())


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_prehash(password), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str | None) -> bool:
    if not hashed:
        return False
    try:
        return bcrypt.checkpw(_prehash(plain), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_access_token(user_id: uuid.UUID, *, extra: dict[str, Any] | None = None) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.access_token_ttl_minutes)).timestamp()),
        "iss": "enrose-autopilot",
        **(extra or {}),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def _decode(token: str) -> dict[str, Any]:
    """Verify a token against whichever issuer this deployment uses."""
    if settings.supabase_live:
        try:
            return jwt.decode(
                token,
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                audience="authenticated",
            )
        except JWTError:
            # Fall through: a locally-issued token is still valid for service calls.
            pass
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token"
        ) from exc


@dataclass
class TenantContext:
    """The authenticated principal plus the client whose data may be touched.

    Every query in the service layer filters on `client_id` from here, which is what
    makes multi-tenancy real rather than aspirational.
    """

    user: User
    client: Client

    @property
    def client_id(self) -> uuid.UUID:
        return self.client.id

    @property
    def user_id(self) -> uuid.UUID:
        return self.user.id


def _resolve_user(db: Session, payload: dict[str, Any]) -> User:
    subject = payload.get("sub")
    if not subject:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token has no subject")

    # Local tokens carry our own user id.
    try:
        user_id = uuid.UUID(str(subject))
    except ValueError:
        user_id = None

    user: User | None = None
    if user_id is not None:
        user = db.get(User, user_id)
    if user is None:
        user = db.execute(select(User).where(User.supabase_uid == str(subject))).scalars().first()
    if user is None and payload.get("email"):
        user = db.execute(select(User).where(User.email == payload["email"])).scalars().first()

    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User is disabled")
    return user


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return _resolve_user(db, _decode(credentials.credentials))


def get_tenant(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> TenantContext:
    """Resolve the client this request operates on.

    Single-membership users resolve implicitly. Multi-client (Phase 4) will read a
    client header here; the rest of the system does not change.
    """
    membership = db.execute(
        select(Membership).where(Membership.user_id == user.id)
    ).scalars().first()
    if membership is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User is not a member of any client"
        )
    client = db.get(Client, membership.client_id)
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Client not found")
    return TenantContext(user=user, client=client)
