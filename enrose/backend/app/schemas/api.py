"""HTTP request and response models."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.enums import ContentFormat


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ── Auth ────────────────────────────────────────────────────────────────────


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in_minutes: int
    user: dict[str, Any]
    client: dict[str, Any]


# ── Clients & brand ─────────────────────────────────────────────────────────


class ClientOut(ORMModel):
    id: uuid.UUID
    name: str
    slug: str
    timezone: str
    status: str


class BrandUpdate(BaseModel):
    """Partial update. Only supplied fields change."""

    description: str | None = None
    positioning: str | None = None
    website: str | None = None
    instagram_handle: str | None = None
    tone: dict[str, Any] | None = None
    visual_identity: dict[str, Any] | None = None
    locations: list[dict[str, Any]] | None = None
    business_goals: list[dict[str, Any]] | None = None
    words_to_avoid: list[str] | None = None
    claims_to_avoid: list[str] | None = None


class ServiceIn(BaseModel):
    name: str
    category: str
    description: str | None = None
    # Null means UNKNOWN. There is no sentinel that could read as a real price.
    price: float | None = None
    currency: str | None = None
    confidence: str = "verified"


class ServiceOut(ServiceIn):
    id: uuid.UUID
    model_config = ConfigDict(from_attributes=True)


class PillarIn(BaseModel):
    key: str
    label: str
    description: str | None = None
    objective: str | None = None
    weight: float = Field(ge=0, le=1)
    examples: list[str] = Field(default_factory=list)


class PillarOut(PillarIn):
    id: uuid.UUID
    source: str
    is_active: bool
    model_config = ConfigDict(from_attributes=True)


class CompetitorIn(BaseModel):
    name: str
    handle: str | None = None
    website: str | None = None
    tier: str = "local"
    notes: str | None = None


# ── Strategy & calendar ─────────────────────────────────────────────────────


class StrategyGenerateRequest(BaseModel):
    period_start: date | None = None
    period_days: int = Field(default=30, ge=7, le=120)
    emphasis: str | None = None
    refresh_brand: bool = False


class StrategyOut(ORMModel):
    id: uuid.UUID
    title: str
    period_start: date
    period_end: date
    pillar_mix: dict[str, float]
    posting_frequency: dict[str, Any]
    format_split: dict[str, int]
    objectives: list[dict[str, Any]]
    audience_focus: list[str]
    themes: list[str]
    rationale: str | None
    status: str
    created_at: datetime


class CalendarGenerateRequest(BaseModel):
    start: date | None = None
    days: int = Field(default=30, ge=7, le=120)
    replace_existing: bool = True


class CalendarEntryOut(ORMModel):
    id: uuid.UUID
    content_item_id: uuid.UUID | None
    scheduled_for: datetime
    slot_label: str | None
    format: str
    pillar: str
    topic: str | None
    status: str
    position: int


class RescheduleRequest(BaseModel):
    scheduled_for: datetime


class AttachContentRequest(BaseModel):
    content_item_id: uuid.UUID


# ── Content ─────────────────────────────────────────────────────────────────


class ContentGenerateRequest(BaseModel):
    format: ContentFormat = ContentFormat.REEL
    pillar: str | None = None
    topic: str | None = None
    objective: str | None = None
    brief: str | None = None
    idea_id: uuid.UUID | None = None
    calendar_entry_id: uuid.UUID | None = None
    count: int = Field(default=1, ge=1, le=10)


class ContentItemSummary(ORMModel):
    id: uuid.UUID
    title: str
    format: str
    pillar: str
    objective: str | None
    status: str
    hook: str | None
    viral_score: float | None
    business_score: float | None
    overall_score: float | None
    scheduled_for: datetime | None
    published_at: datetime | None
    created_at: datetime


class ContentItemDetail(ContentItemSummary):
    caption: str | None
    cta: str | None
    hashtags: list[str]
    payload: dict[str, Any]
    score_breakdown: dict[str, Any]
    qa_report: dict[str, Any]
    approval_level: str


class ContentUpdate(BaseModel):
    title: str | None = None
    hook: str | None = None
    caption: str | None = None
    cta: str | None = None
    hashtags: list[str] | None = None


class ApprovalRequest(BaseModel):
    note: str | None = None


class ScheduleRequest(BaseModel):
    publish_at: datetime


class GenerationResponse(BaseModel):
    items: list[ContentItemSummary]
    rejected: list[dict[str, Any]] = Field(default_factory=list)
    cost_usd: float
    provider: str


# ── Assets ──────────────────────────────────────────────────────────────────


class AssetOut(ORMModel):
    id: uuid.UUID
    filename: str
    kind: str
    storage_key: str
    mime_type: str | None
    size_bytes: int | None
    duration_s: float | None
    footage_type: str
    tags: list[str]
    notes: str | None
    shoot_group: str | None
    provider: str
    created_at: datetime


class AttachAssetsRequest(BaseModel):
    asset_ids: list[uuid.UUID]
    role: str = "broll"


class FootageAnalyzeRequest(BaseModel):
    asset_ids: list[uuid.UUID] | None = None
    shoot_group: str | None = None


# ── Analytics ───────────────────────────────────────────────────────────────


class AnalyzeRequest(BaseModel):
    days: int = Field(default=30, ge=1, le=365)


class MetricIngestItem(BaseModel):
    """Manual metric entry, for accounts not yet connected to the Graph API."""

    content_item_id: uuid.UUID
    reach: int = 0
    impressions: int = 0
    views: int = 0
    likes: int = 0
    comments: int = 0
    shares: int = 0
    saves: int = 0
    follows: int = 0
    profile_visits: int = 0
    link_clicks: int = 0
    captured_at: datetime | None = None


# ── Command centre ──────────────────────────────────────────────────────────


class CommandRequest(BaseModel):
    command: str = Field(min_length=3, max_length=2000)
    execute: bool = Field(
        default=False,
        description="When true, the returned plan's steps are actually executed.",
    )


class CommandResponse(BaseModel):
    plan: dict[str, Any]
    executed: list[dict[str, Any]] = Field(default_factory=list)
    cost_usd: float
    provider: str
