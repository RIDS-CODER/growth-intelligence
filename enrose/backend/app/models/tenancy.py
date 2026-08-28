"""Users, clients and memberships — the tenancy root."""

from __future__ import annotations

import uuid

from sqlalchemy import Boolean, ForeignKey, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDMixin


class User(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    full_name: Mapped[str | None] = mapped_column(String(200))
    # Set when the principal comes from Supabase; null for local password auth.
    supabase_uid: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str | None] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(32), default="owner", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    memberships: Mapped[list["Membership"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Client(Base, UUIDMixin, TimestampMixin):
    """A tenant. Enrose Salon is client #1."""

    __tablename__ = "clients"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    slug: Mapped[str] = mapped_column(String(80), unique=True, nullable=False, index=True)
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Kolkata", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="active", nullable=False)

    memberships: Mapped[list["Membership"]] = relationship(
        back_populates="client", cascade="all, delete-orphan"
    )


class Membership(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("user_id", "client_id", name="uq_membership_user_client"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    client_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(String(32), default="owner", nullable=False)

    user: Mapped[User] = relationship(back_populates="memberships")
    client: Mapped[Client] = relationship(back_populates="memberships")
