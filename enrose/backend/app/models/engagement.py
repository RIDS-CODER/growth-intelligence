"""Leads, comments and DMs.

Phase 3 functionality, but the schema ships now so attribution
(content → profile visit → DM → booking) can be recorded from the first published post.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db import JSONType
from app.enums import LeadIntent
from app.models.base import Base, ClientScopedMixin, TimestampMixin, UUIDMixin


class Lead(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "leads"

    handle: Mapped[str | None] = mapped_column(String(120))
    name: Mapped[str | None] = mapped_column(String(200))
    source: Mapped[str] = mapped_column(String(40), default="instagram_dm", nullable=False)
    intent: Mapped[str] = mapped_column(String(16), default=LeadIntent.UNKNOWN.value, nullable=False)
    score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    requested_service: Mapped[str | None] = mapped_column(String(200))
    message: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(24), default="new", nullable=False, index=True)
    # Which post produced this lead — the link that lets the analyst rank content
    # by bookings rather than views.
    attributed_content_item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("content_items.id", ondelete="SET NULL")
    )
    contact: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)


class Comment(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "comments"

    content_item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("content_items.id", ondelete="CASCADE"), index=True
    )
    platform_comment_id: Mapped[str | None] = mapped_column(String(120))
    author_handle: Mapped[str | None] = mapped_column(String(120))
    body: Mapped[str] = mapped_column(Text, nullable=False)
    classification: Mapped[str | None] = mapped_column(String(32), index=True)
    suggested_reply: Mapped[str | None] = mapped_column(Text)
    # Complaints and negative sentiment are never auto-answered; the service layer
    # forces this true regardless of what the classifier suggests.
    requires_human: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    replied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DMThread(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "dm_threads"

    platform_thread_id: Mapped[str | None] = mapped_column(String(120))
    handle: Mapped[str | None] = mapped_column(String(120))
    intent: Mapped[str | None] = mapped_column(String(40))
    lead_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("leads.id", ondelete="SET NULL"))
    last_message: Mapped[str | None] = mapped_column(Text)
    suggested_reply: Mapped[str | None] = mapped_column(Text)
    escalated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="open", nullable=False)
    messages: Mapped[list[dict[str, Any]]] = mapped_column(JSONType, default=list)
