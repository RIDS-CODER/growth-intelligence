"""The Brand Brain: everything the AI is allowed to reason from."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import JSONType
from app.enums import Confidence
from app.models.base import Base, ClientScopedMixin, TimestampMixin, UUIDMixin


class Brand(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "brands"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    website: Mapped[str | None] = mapped_column(String(500))
    instagram_handle: Mapped[str | None] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text)
    positioning: Mapped[str | None] = mapped_column(Text)

    tone: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)
    visual_identity: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)
    locations: Mapped[list[dict[str, Any]]] = mapped_column(JSONType, default=list)
    business_goals: Mapped[list[dict[str, Any]]] = mapped_column(JSONType, default=list)

    words_to_avoid: Mapped[list[str]] = mapped_column(JSONType, default=list)
    claims_to_avoid: Mapped[list[str]] = mapped_column(JSONType, default=list)

    # Field names the client still has to supply. Rendered verbatim into prompts as
    # "UNKNOWN — you may not assert this", and surfaced in the Brand Brain UI as gaps.
    unknown_fields: Mapped[list[str]] = mapped_column(JSONType, default=list)
    completeness: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    # Per-field provenance: {"positioning": "verified", "audience": "inferred", ...}
    provenance: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)

    services: Mapped[list["Service"]] = relationship(
        back_populates="brand", cascade="all, delete-orphan"
    )
    products: Mapped[list["Product"]] = relationship(
        back_populates="brand", cascade="all, delete-orphan"
    )
    audiences: Mapped[list["Audience"]] = relationship(
        back_populates="brand", cascade="all, delete-orphan"
    )
    assets: Mapped[list["BrandAsset"]] = relationship(
        back_populates="brand", cascade="all, delete-orphan"
    )


class BrandAsset(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "brand_assets"

    brand_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("brands.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(40), nullable=False)  # logo|guidelines|image|video
    label: Mapped[str | None] = mapped_column(String(200))
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    meta: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)

    brand: Mapped[Brand] = relationship(back_populates="assets")


class Service(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    """A service Enrose actually offers.

    `price` is nullable and null means UNKNOWN. There is deliberately no zero or
    sentinel value that a model could read as a real number.
    """

    __tablename__ = "services"

    brand_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("brands.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[str] = mapped_column(String(60), nullable=False)  # hair|skin|nails|spa|bridal
    description: Mapped[str | None] = mapped_column(Text)
    price: Mapped[float | None] = mapped_column(Float)
    currency: Mapped[str | None] = mapped_column(String(8))
    confidence: Mapped[str] = mapped_column(String(20), default=Confidence.VERIFIED.value, nullable=False)
    source: Mapped[str | None] = mapped_column(String(300))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    brand: Mapped[Brand] = relationship(back_populates="services")


class Product(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    """Professional product brands carried by the salon. The only ones the AI may name."""

    __tablename__ = "products"

    brand_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("brands.id", ondelete="CASCADE"), nullable=False, index=True
    )
    brand_name: Mapped[str] = mapped_column(String(120), nullable=False)
    category: Mapped[str | None] = mapped_column(String(60))
    notes: Mapped[str | None] = mapped_column(Text)
    confidence: Mapped[str] = mapped_column(String(20), default=Confidence.VERIFIED.value, nullable=False)
    source: Mapped[str | None] = mapped_column(String(300))

    brand: Mapped[Brand] = relationship(back_populates="products")


class Audience(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "audiences"

    brand_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("brands.id", ondelete="CASCADE"), nullable=False, index=True
    )
    segment: Mapped[str] = mapped_column(String(160), nullable=False)
    demographics: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)
    pains: Mapped[list[str]] = mapped_column(JSONType, default=list)
    desires: Mapped[list[str]] = mapped_column(JSONType, default=list)
    priority: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    confidence: Mapped[str] = mapped_column(String(20), default=Confidence.INFERRED.value, nullable=False)

    brand: Mapped[Brand] = relationship(back_populates="audiences")


class Competitor(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    __tablename__ = "competitors"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    handle: Mapped[str | None] = mapped_column(String(120))
    website: Mapped[str | None] = mapped_column(String(500))
    tier: Mapped[str] = mapped_column(String(40), default="local", nullable=False)  # local|national|aspirational
    notes: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_analyzed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ContentPillar(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    """Pillars are data, never hard-coded.

    Seeded with candidates, then discovered, reweighted and retired by the
    strategist and learning agents.
    """

    __tablename__ = "content_pillars"

    key: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    objective: Mapped[str | None] = mapped_column(String(40))
    weight: Mapped[float] = mapped_column(Float, default=0.1, nullable=False)
    examples: Mapped[list[str]] = mapped_column(JSONType, default=list)
    source: Mapped[str] = mapped_column(String(24), default="seed", nullable=False)  # seed|ai_discovered|client
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class BrandMemory(Base, UUIDMixin, ClientScopedMixin, TimestampMixin):
    """Durable learned insight injected into downstream prompts.

    Insights expire, and a newer contradicting insight supersedes an older one, so
    the system's beliefs decay rather than accumulating forever.
    """

    __tablename__ = "brand_memory"

    insight: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(String(40), default="performance", nullable=False)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)
    confidence: Mapped[float] = mapped_column(Float, default=0.5, nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    superseded_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
