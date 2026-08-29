"""Strategy, campaigns, calendar, and the content spine."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import JSONType
from app.enums import ApprovalLevel, ContentFormat, ContentStatus
from app.models.base import Base, ClientScopedMixin, TimestampMixin, UUIDMixin


class Strategy(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    """One strategy per content cycle. Carries the reasoning, not just the numbers."""

    __tablename__ = "strategies"

    title: Mapped[str] = mapped_column(String(200), nullable=False)
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)
    pillar_mix: Mapped[dict[str, float]] = mapped_column(JSONType, default=dict)
    posting_frequency: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)
    format_split: Mapped[dict[str, int]] = mapped_column(JSONType, default=dict)
    objectives: Mapped[list[dict[str, Any]]] = mapped_column(JSONType, default=list)
    audience_focus: Mapped[list[str]] = mapped_column(JSONType, default=list)
    themes: Mapped[list[str]] = mapped_column(JSONType, default=list)
    rationale: Mapped[str | None] = mapped_column(Text)
    # brand_memory ids that shaped this strategy — makes strategy change auditable.
    derived_from_insights: Mapped[list[str]] = mapped_column(JSONType, default=list)
    status: Mapped[str] = mapped_column(String(24), default="active", nullable=False)


class Campaign(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "campaigns"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    goal: Mapped[str | None] = mapped_column(Text)
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    strategy_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("strategies.id", ondelete="SET NULL")
    )
    # Campaigns are approval level 3 by policy: they carry offers and claims.
    status: Mapped[str] = mapped_column(String(24), default="planned", nullable=False)
    meta: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)


class ContentIdea(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    """Pre-production backlog. Promoted into a ContentItem when chosen."""

    __tablename__ = "content_ideas"

    title: Mapped[str] = mapped_column(String(300), nullable=False)
    pillar: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    format: Mapped[str] = mapped_column(String(24), default=ContentFormat.REEL.value, nullable=False)
    objective: Mapped[str | None] = mapped_column(String(40))
    hook: Mapped[str | None] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text)
    viral_score: Mapped[float | None] = mapped_column(Float)
    business_score: Mapped[float | None] = mapped_column(Float)
    overall_score: Mapped[float | None] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(40), default="content_strategist", nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="open", nullable=False)
    promoted_content_item_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)


class ContentItem(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    """The spine of the system.

    `payload` holds the format-specific creative body (shot list for a reel, slides
    for a carousel) so adding a format does not require a migration; everything the
    app filters, sorts or joins on is a real column.
    """

    __tablename__ = "content_items"
    __table_args__ = (
        Index("ix_content_items_client_status", "client_id", "status"),
        Index("ix_content_items_client_scheduled", "client_id", "scheduled_for"),
        Index("ix_content_items_client_pillar", "client_id", "pillar"),
    )

    title: Mapped[str] = mapped_column(String(300), nullable=False)
    format: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    pillar: Mapped[str] = mapped_column(String(60), nullable=False)
    objective: Mapped[str | None] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(
        String(32), default=ContentStatus.IDEA.value, nullable=False, index=True
    )

    hook: Mapped[str | None] = mapped_column(Text)
    caption: Mapped[str | None] = mapped_column(Text)
    cta: Mapped[str | None] = mapped_column(Text)
    hashtags: Mapped[list[str]] = mapped_column(JSONType, default=list)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)

    viral_score: Mapped[float | None] = mapped_column(Float)
    business_score: Mapped[float | None] = mapped_column(Float)
    overall_score: Mapped[float | None] = mapped_column(Float)
    score_breakdown: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)
    qa_report: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)

    approval_level: Mapped[str] = mapped_column(
        String(32), default=ApprovalLevel.L1_HUMAN_REQUIRED.value, nullable=False
    )
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    strategy_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("strategies.id", ondelete="SET NULL")
    )
    campaign_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("campaigns.id", ondelete="SET NULL")
    )
    idea_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("content_ideas.id", ondelete="SET NULL")
    )

    variants: Mapped[list["ContentVariant"]] = relationship(
        back_populates="content_item", cascade="all, delete-orphan"
    )
    asset_links: Mapped[list["ContentAsset"]] = relationship(
        back_populates="content_item", cascade="all, delete-orphan"
    )
    approvals: Mapped[list["Approval"]] = relationship(
        back_populates="content_item", cascade="all, delete-orphan"
    )


class ContentVariant(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "content_variants"

    content_item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("content_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(32), nullable=False)  # caption|hook|cover|cta
    label: Mapped[str | None] = mapped_column(String(120))
    body: Mapped[str] = mapped_column(Text, nullable=False)
    is_selected: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    meta: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)

    content_item: Mapped[ContentItem] = relationship(back_populates="variants")


class Asset(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    """Uploaded media, including raw salon footage."""

    __tablename__ = "assets"

    filename: Mapped[str] = mapped_column(String(300), nullable=False)
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size_bytes: Mapped[int | None] = mapped_column(Integer)
    duration_s: Mapped[float | None] = mapped_column(Float)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    footage_type: Mapped[str] = mapped_column(String(24), default="untagged", nullable=False, index=True)
    tags: Mapped[list[str]] = mapped_column(JSONType, default=list)
    notes: Mapped[str | None] = mapped_column(Text)
    analysis: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)
    shoot_group: Mapped[str | None] = mapped_column(String(120), index=True)
    provider: Mapped[str] = mapped_column(String(16), default="local", nullable=False)


class ContentAsset(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "content_assets"

    content_item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("content_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    asset_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("assets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(String(32), default="broll", nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    content_item: Mapped[ContentItem] = relationship(back_populates="asset_links")
    asset: Mapped[Asset] = relationship()


class CalendarEntry(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "calendar_entries"
    __table_args__ = (Index("ix_calendar_client_time", "client_id", "scheduled_for"),)

    content_item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("content_items.id", ondelete="CASCADE"), index=True
    )
    strategy_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("strategies.id", ondelete="SET NULL")
    )
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    slot_label: Mapped[str | None] = mapped_column(String(60))
    format: Mapped[str] = mapped_column(String(24), nullable=False)
    pillar: Mapped[str] = mapped_column(String(60), nullable=False)
    topic: Mapped[str | None] = mapped_column(String(300))
    status: Mapped[str] = mapped_column(String(32), default="planned", nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class Approval(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "approvals"

    content_item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("content_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    decision: Mapped[str] = mapped_column(String(32), nullable=False)
    level: Mapped[str] = mapped_column(String(32), nullable=False)
    actor_type: Mapped[str] = mapped_column(String(16), default="user", nullable=False)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    note: Mapped[str | None] = mapped_column(Text)

    content_item: Mapped[ContentItem] = relationship(back_populates="approvals")


class ContentMemory(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    """Anti-repetition index.

    Fingerprints are normalised token sets; `services/memory.py` does Jaccard
    similarity against them before generation, so near-duplicates are killed
    without spending a token.
    """

    __tablename__ = "content_memory"
    __table_args__ = (
        Index("ix_content_memory_client_topic", "client_id", "topic_fingerprint"),
        Index("ix_content_memory_client_pillar", "client_id", "pillar"),
    )

    content_item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("content_items.id", ondelete="SET NULL")
    )
    topic: Mapped[str] = mapped_column(String(300), nullable=False)
    hook: Mapped[str | None] = mapped_column(Text)
    topic_fingerprint: Mapped[str] = mapped_column(String(500), nullable=False)
    hook_fingerprint: Mapped[str | None] = mapped_column(String(500))
    pillar: Mapped[str] = mapped_column(String(60), nullable=False)
    format: Mapped[str] = mapped_column(String(24), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    outcome: Mapped[str | None] = mapped_column(String(24))  # winner|average|poor|unknown
    performance_index: Mapped[float | None] = mapped_column(Float)
