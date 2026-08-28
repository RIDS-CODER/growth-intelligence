"""Observability: every AI call and every state change is recorded."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import Boolean, Float, Index, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db import JSONType
from app.models.base import Base, ClientScopedMixin, TimestampMixin, UUIDMixin


class AIActivityLog(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    """One row per model call, success or failure.

    Makes cost attributable per agent and per content item instead of arriving as
    one opaque monthly bill, and gives every generated artefact a traceable origin.
    """

    __tablename__ = "ai_activity_log"
    __table_args__ = (
        Index("ix_ai_log_client_time", "client_id", "created_at"),
        Index("ix_ai_log_agent_time", "agent", "created_at"),
    )

    agent: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    task: Mapped[str] = mapped_column(String(120), nullable=False)
    # Digest rather than the full prompt: prompts can be large and may carry client
    # detail, while a digest is enough to detect drift and dedupe.
    input_digest: Mapped[str | None] = mapped_column(String(64))
    input_summary: Mapped[str | None] = mapped_column(Text)
    output: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)
    model: Mapped[str | None] = mapped_column(String(80))
    provider: Mapped[str] = mapped_column(String(16), default="mock", nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    success: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    retries: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    content_item_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, index=True)


class AuditLog(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "audit_logs"

    actor_type: Mapped[str] = mapped_column(String(16), default="system", nullable=False)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    actor_label: Mapped[str | None] = mapped_column(String(120))
    action: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    entity: Mapped[str] = mapped_column(String(60), nullable=False)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, index=True)
    before: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)
    after: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)
    note: Mapped[str | None] = mapped_column(Text)
