"""Declarative base and the mixins every domain table shares."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Uuid, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class UUIDMixin:
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now(), nullable=False
    )


class ClientScopedMixin:
    """The tenancy boundary.

    Present on every domain table from day one so multi-client (Phase 4) is a row,
    not a migration. Every query in the service layer filters on it.
    """

    @property
    def _client_fk(self) -> None:  # pragma: no cover - documentation hook
        ...

    client_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True
    )
