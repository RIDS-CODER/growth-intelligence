"""Performance metrics and the insights derived from them."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db import JSONType
from app.models.base import Base, ClientScopedMixin, TimestampMixin, UUIDMixin


class AnalyticsSnapshot(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    """Append-only metric reading for one post at one moment.

    Snapshots are never mutated in place, so growth curves stay reconstructable and
    the analyst can reason about velocity, not just final totals.
    """

    __tablename__ = "analytics_snapshots"
    __table_args__ = (
        Index("ix_snapshots_item_time", "content_item_id", "captured_at"),
        Index("ix_snapshots_client_time", "client_id", "captured_at"),
    )

    content_item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("content_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    published_post_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("published_posts.id", ondelete="SET NULL")
    )
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    reach: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    impressions: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    views: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    likes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    comments: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    shares: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    saves: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    follows: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    profile_visits: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    link_clicks: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    engagement_rate: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    avg_watch_time_s: Mapped[float | None] = mapped_column(Float)
    provider: Mapped[str] = mapped_column(String(16), default="mock", nullable=False)
    raw: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)


class AIInsight(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    """A comparative, causal finding from the performance analyst.

    Deliberately not a metric restatement — `body` must explain a difference between
    cohorts and `recommendation` must be actionable next cycle.
    """

    __tablename__ = "ai_insights"

    title: Mapped[str] = mapped_column(String(300), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(String(40), default="performance", nullable=False)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)
    confidence: Mapped[float] = mapped_column(Float, default=0.5, nullable=False)
    recommendation: Mapped[str | None] = mapped_column(Text)
    period_days: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
