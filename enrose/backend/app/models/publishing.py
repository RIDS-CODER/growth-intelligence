"""Social connections and the publish pipeline."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db import JSONType
from app.enums import PublishStatus
from app.models.base import Base, ClientScopedMixin, TimestampMixin, UUIDMixin


class SocialAccount(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    """An OAuth-connected publishing destination.

    `is_mock` is stored, not inferred, so a published post can always be traced back
    to whether it went to a real account. A mock post is never presented as real.
    """

    __tablename__ = "social_accounts"

    platform: Mapped[str] = mapped_column(String(32), default="instagram", nullable=False)
    handle: Mapped[str | None] = mapped_column(String(120))
    ig_user_id: Mapped[str | None] = mapped_column(String(64))
    page_id: Mapped[str | None] = mapped_column(String(64))
    # Encrypt at rest in production (KMS / pgcrypto); never returned by the API.
    access_token: Mapped[str | None] = mapped_column(Text)
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scopes: Mapped[list[str]] = mapped_column(JSONType, default=list)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_mock: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    meta: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)


class ScheduledPost(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "scheduled_posts"
    __table_args__ = (Index("ix_scheduled_posts_due", "status", "publish_at"),)

    content_item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("content_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    social_account_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("social_accounts.id", ondelete="SET NULL")
    )
    publish_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(
        String(24), default=PublishStatus.PENDING.value, nullable=False, index=True
    )
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_error: Mapped[str | None] = mapped_column(Text)
    provider: Mapped[str] = mapped_column(String(16), default="mock", nullable=False)


class PublishedPost(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "published_posts"

    content_item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("content_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    scheduled_post_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("scheduled_posts.id", ondelete="SET NULL")
    )
    platform: Mapped[str] = mapped_column(String(32), default="instagram", nullable=False)
    platform_post_id: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    permalink: Mapped[str | None] = mapped_column(String(500))
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    provider: Mapped[str] = mapped_column(String(16), default="mock", nullable=False)
    meta: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)
