"""Authentication routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models.tenancy import Client, Membership, User
from app.schemas.api import LoginRequest, TokenResponse
from app.security import TenantContext, create_access_token, get_tenant, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    user = db.execute(
        select(User).where(User.email == payload.email.lower())
    ).scalars().first()

    if user is None or not verify_password(payload.password, user.password_hash):
        # Same message either way: distinguishing them tells an attacker which
        # emails exist.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password"
        )
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User is disabled")

    membership = db.execute(
        select(Membership).where(Membership.user_id == user.id)
    ).scalars().first()
    if membership is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User is not a member of any client"
        )
    client = db.get(Client, membership.client_id)

    return TokenResponse(
        access_token=create_access_token(user.id),
        expires_in_minutes=settings.access_token_ttl_minutes,
        user={"id": str(user.id), "email": user.email, "full_name": user.full_name, "role": user.role},
        client={"id": str(client.id), "name": client.name, "slug": client.slug} if client else {},
    )


@router.get("/me")
def me(tenant: TenantContext = Depends(get_tenant)) -> dict:
    return {
        "user": {
            "id": str(tenant.user.id),
            "email": tenant.user.email,
            "full_name": tenant.user.full_name,
            "role": tenant.user.role,
        },
        "client": {
            "id": str(tenant.client.id),
            "name": tenant.client.name,
            "slug": tenant.client.slug,
            "timezone": tenant.client.timezone,
        },
    }
