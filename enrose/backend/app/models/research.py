"""Trend database and competitor observations."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Date, DateTime, Float, ForeignKey, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db import JSONType
from app.enums import TrendStatus
from app.models.base import Base, ClientScopedMixin, TimestampMixin, UUIDMixin


class Trend(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    """A detected trend and, crucially, whether it actually fits Enrose.

    A trend with `fits_brand=False` is kept with its reason rather than deleted —
    that record is what stops the same bad idea being re-proposed next cycle.
    """

    __tablename__ = "trends"

    name: Mapped[str] = mapped_column(String(300), nullable=False)
    category: Mapped[str] = mapped_column(String(60), nullable=False)  # format|beauty|hair|nails|seasonal|audio
    description: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str | None] = mapped_column(String(200))
    detected_on: Mapped[date] = mapped_column(Date, nullable=False)
    popularity: Mapped[str | None] = mapped_column(String(24))  # emerging|rising|peak|declining
    relevance_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    expiry_probability: Mapped[float | None] = mapped_column(Float)
    expires_on: Mapped[date | None] = mapped_column(Date)
    fits_brand: Mapped[bool | None] = mapped_column()
    fit_reason: Mapped[str | None] = mapped_column(Text)
    recommended_adaptation: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(
        String(24), default=TrendStatus.DETECTED.value, nullable=False, index=True
    )
    meta: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)


class CompetitorPost(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "competitor_posts"

    competitor_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("competitors.id", ondelete="CASCADE"), nullable=False, index=True
    )
    platform_post_id: Mapped[str | None] = mapped_column(String(120))
    permalink: Mapped[str | None] = mapped_column(String(500))
    format: Mapped[str | None] = mapped_column(String(24))
    topic: Mapped[str | None] = mapped_column(String(300))
    hook: Mapped[str | None] = mapped_column(Text)
    caption: Mapped[str | None] = mapped_column(Text)
    posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    likes: Mapped[int | None] = mapped_column(Integer)
    comments: Mapped[int | None] = mapped_column(Integer)
    engagement_estimate: Mapped[float | None] = mapped_column(Float)
    observed_pattern: Mapped[str | None] = mapped_column(Text)
    provider: Mapped[str] = mapped_column(String(16), default="mock", nullable=False)
