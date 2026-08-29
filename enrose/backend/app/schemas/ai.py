"""Structured AI output contracts.

Every agent declares one of these as its output model. The JSON Schema derived from
it is sent to Claude as a forced tool definition, and the response is validated
against it before any application code touches it. Application logic never branches
on free-form model prose.

`extra="forbid"` throughout: a model inventing an unexpected field is a validation
failure we want to see, not silently absorb.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── Agent 1: Brand Strategist ───────────────────────────────────────────────


class PillarProposal(StrictModel):
    key: str = Field(max_length=60)
    label: str
    description: str
    objective: Literal[
        "reach", "engagement", "saves", "profile_visits", "bookings", "authority", "community"
    ]
    weight: float = Field(ge=0, le=1)
    examples: list[str] = Field(default_factory=list, max_length=8)


class AudienceProposal(StrictModel):
    segment: str
    demographics: dict[str, str] = Field(default_factory=dict)
    pains: list[str] = Field(default_factory=list, max_length=8)
    desires: list[str] = Field(default_factory=list, max_length=8)
    priority: int = Field(ge=1, le=5)
    confidence: Literal["verified", "reported", "inferred", "unknown"]


class BrandStrategy(StrictModel):
    positioning: str
    tone_rules: list[str] = Field(min_length=1, max_length=12)
    words_to_favour: list[str] = Field(default_factory=list, max_length=20)
    words_to_avoid: list[str] = Field(default_factory=list, max_length=20)
    visual_direction: list[str] = Field(default_factory=list, max_length=10)
    audiences: list[AudienceProposal] = Field(min_length=1, max_length=6)
    pillars: list[PillarProposal] = Field(min_length=3, max_length=10)
    strategic_objectives: list[str] = Field(min_length=1, max_length=8)
    # The questions the client must answer to unlock better content. This is how the
    # system asks for what it does not know instead of inventing it.
    information_gaps: list[str] = Field(default_factory=list, max_length=20)
    rationale: str


# ── Agent 2: Trend Researcher ───────────────────────────────────────────────


class TrendItem(StrictModel):
    name: str
    category: Literal["format", "beauty", "hair", "nails", "skin", "salon", "seasonal", "audio", "topic"]
    description: str
    popularity: Literal["emerging", "rising", "peak", "declining"]
    relevance_score: float = Field(ge=0, le=100)
    expiry_probability: float = Field(ge=0, le=1)
    # The gate that matters: a trend that does not fit is recorded with a reason,
    # never force-fitted onto the brand.
    fits_brand: bool
    fit_reason: str
    recommended_adaptation: str
    recommended_action: Literal["adopt", "monitor", "ignore"]


class TrendReport(StrictModel):
    trends: list[TrendItem] = Field(min_length=1, max_length=20)
    seasonal_opportunities: list[str] = Field(default_factory=list, max_length=12)
    hook_patterns: list[str] = Field(default_factory=list, max_length=12)
    format_patterns: list[str] = Field(default_factory=list, max_length=12)
    summary: str


# ── Agent 3: Competitor Analyst ─────────────────────────────────────────────


class CompetitorProfile(StrictModel):
    name: str
    posting_frequency: str
    dominant_formats: list[str] = Field(default_factory=list, max_length=6)
    dominant_topics: list[str] = Field(default_factory=list, max_length=8)
    hook_style: str
    visual_style: str
    observed_offers: list[str] = Field(default_factory=list, max_length=6)
    engagement_signal: Literal["low", "moderate", "high", "unknown"]
    what_works: list[str] = Field(default_factory=list, max_length=6)


class CompetitorReport(StrictModel):
    profiles: list[CompetitorProfile] = Field(default_factory=list, max_length=12)
    # The actual deliverable: what the competitive set is NOT doing that Enrose can own.
    exploitable_gaps: list[str] = Field(min_length=1, max_length=12)
    differentiation_strategy: str
    do_not_copy: list[str] = Field(default_factory=list, max_length=8)
    summary: str


# ── Agent 4: Content Strategist ─────────────────────────────────────────────


class StrategyObjective(StrictModel):
    objective: Literal[
        "reach", "engagement", "saves", "profile_visits", "bookings", "authority", "community"
    ]
    target: str
    why: str


class ContentIdeaOut(StrictModel):
    title: str
    pillar: str
    format: Literal["reel", "carousel", "static", "story"]
    objective: Literal[
        "reach", "engagement", "saves", "profile_visits", "bookings", "authority", "community"
    ]
    hook: str
    summary: str
    priority: int = Field(ge=1, le=5)
    rationale: str


class ContentStrategy(StrictModel):
    title: str
    pillar_mix: dict[str, float]
    posting_frequency: dict[str, int]
    format_split: dict[str, int]
    objectives: list[StrategyObjective] = Field(min_length=1, max_length=6)
    audience_focus: list[str] = Field(default_factory=list, max_length=6)
    themes: list[str] = Field(default_factory=list, max_length=10)
    ideas: list[ContentIdeaOut] = Field(default_factory=list, max_length=40)
    rationale: str


# ── Agent 5: Reel Writer ────────────────────────────────────────────────────


class Shot(StrictModel):
    index: int = Field(ge=1)
    duration_s: float = Field(gt=0, le=30)
    description: str
    camera: str
    on_screen_text: str | None = None


class ReelDraft(StrictModel):
    title: str
    concept: str
    pillar: str
    objective: Literal[
        "reach", "engagement", "saves", "profile_visits", "bookings", "authority", "community"
    ]
    hook: str
    first_three_seconds: str
    script: str
    shots: list[Shot] = Field(min_length=2, max_length=12)
    on_screen_text: list[str] = Field(default_factory=list, max_length=12)
    voiceover: str | None = None
    editing_instructions: list[str] = Field(default_factory=list, max_length=12)
    broll_requirements: list[str] = Field(default_factory=list, max_length=10)
    music_direction: str | None = None
    cta: str
    caption: str
    hashtags: list[str] = Field(default_factory=list, max_length=30)
    cover_text: str
    estimated_duration_s: float = Field(gt=0, le=180)


# ── Agent 6: Carousel Writer ────────────────────────────────────────────────


class Slide(StrictModel):
    index: int = Field(ge=1)
    headline: str
    body: str | None = None
    visual_instruction: str
    template_key: str


class CarouselDraft(StrictModel):
    title: str
    pillar: str
    objective: Literal[
        "reach", "engagement", "saves", "profile_visits", "bookings", "authority", "community"
    ]
    hook: str
    cover_text: str
    slides: list[Slide] = Field(min_length=4, max_length=10)
    cta: str
    caption: str
    hashtags: list[str] = Field(default_factory=list, max_length=30)


# ── Agent 7: Story Writer ───────────────────────────────────────────────────


class StoryFrame(StrictModel):
    index: int = Field(ge=1)
    category: Literal[
        "poll", "question", "quiz", "before_after", "product", "tip",
        "cta", "testimonial", "bts", "offer", "interactive",
    ]
    visual: str
    text: str
    interactive_prompt: str | None = None


class StorySequence(StrictModel):
    day: str
    frames: list[StoryFrame] = Field(min_length=2, max_length=8)
    # Stories are generated bound to the day's feed post so the account reads as one
    # coordinated day rather than disconnected fragments.
    links_to_feed_topic: str | None = None
    rationale: str


# ── Agent 8: Caption Writer ─────────────────────────────────────────────────


class CaptionVariant(StrictModel):
    label: Literal["short", "medium", "long"]
    body: str


class CaptionSet(StrictModel):
    hook_line: str
    variants: list[CaptionVariant] = Field(min_length=2, max_length=3)
    cta: str
    hashtags_broad: list[str] = Field(default_factory=list, max_length=10)
    hashtags_niche: list[str] = Field(default_factory=list, max_length=10)
    hashtags_local: list[str] = Field(default_factory=list, max_length=10)
    alt_text: str


# ── Agent 9: Virality Scorer ────────────────────────────────────────────────


class ScoredDimension(StrictModel):
    score: float = Field(ge=0, le=100)
    reason: str


class ViralityAssessment(StrictModel):
    """Sub-scores only.

    The roll-up into viral/business/overall is deterministic Python in
    `services/virality.py`, so a 78 in March means the same as a 78 in September.
    """

    hook_strength: ScoredDimension
    curiosity: ScoredDimension
    emotional_response: ScoredDimension
    shareability: ScoredDimension
    saveability: ScoredDimension
    rewatch_potential: ScoredDimension
    relatability: ScoredDimension
    trend_alignment: ScoredDimension
    visual_transformation: ScoredDimension
    audience_relevance: ScoredDimension
    brand_fit: ScoredDimension
    conversion_potential: ScoredDimension
    predicted_top_percentile: float = Field(ge=0, le=100)
    biggest_weakness: str
    concrete_fix: str
    explanation: str


# ── Agent 10: QA Reviewer ───────────────────────────────────────────────────


class QACheck(StrictModel):
    check: str
    passed: bool
    severity: Literal["info", "warning", "blocking"]
    detail: str


class QAReport(StrictModel):
    checks: list[QACheck] = Field(min_length=1, max_length=20)
    approved: bool
    blocking_reasons: list[str] = Field(default_factory=list, max_length=10)
    suggested_edits: list[str] = Field(default_factory=list, max_length=10)
    summary: str


# ── Agent 11: Performance Analyst ───────────────────────────────────────────


class PerformanceFinding(StrictModel):
    """A comparative, causal finding.

    `comparison` is mandatory precisely to stop the model restating a raw metric:
    "reel got 20k views" cannot be expressed in this shape.
    """

    headline: str
    comparison: str
    magnitude: str
    why: list[str] = Field(min_length=1, max_length=6)
    evidence: dict[str, float] = Field(default_factory=dict)
    confidence: float = Field(ge=0, le=1)


class StrategyDelta(StrictModel):
    pillar: str
    change_pct: float = Field(ge=-100, le=100)
    reason: str


class PerformanceAnalysis(StrictModel):
    period_days: int = Field(ge=1, le=365)
    findings: list[PerformanceFinding] = Field(default_factory=list, max_length=10)
    do_more_of: list[str] = Field(default_factory=list, max_length=8)
    do_less_of: list[str] = Field(default_factory=list, max_length=8)
    stop_doing: list[str] = Field(default_factory=list, max_length=6)
    strategy_deltas: list[StrategyDelta] = Field(default_factory=list, max_length=10)
    headline_recommendation: str
    data_sufficiency: Literal["insufficient", "limited", "adequate", "strong"]
    summary: str


# ── Agent 12: Learning Agent ────────────────────────────────────────────────


class LearnedInsight(StrictModel):
    insight: str
    kind: Literal["performance", "audience", "format", "timing", "topic", "brand"]
    evidence: dict[str, float] = Field(default_factory=dict)
    confidence: float = Field(ge=0, le=1)
    expires_in_days: int = Field(ge=7, le=365)


class LearningUpdate(StrictModel):
    insights: list[LearnedInsight] = Field(default_factory=list, max_length=10)
    superseded_insights: list[str] = Field(default_factory=list, max_length=10)
    pillar_weight_deltas: dict[str, float] = Field(default_factory=dict)
    summary: str


# ── Agent 13: Footage Analyst ───────────────────────────────────────────────


class FootageClipUse(StrictModel):
    asset_id: str
    order: int = Field(ge=1)
    start_s: float = Field(ge=0)
    end_s: float = Field(gt=0)
    purpose: str
    overlay_text: str | None = None


class MissingShot(StrictModel):
    shot: str
    why_it_matters: str
    duration_s: float = Field(gt=0, le=30)


class FootageAnalysis(StrictModel):
    recommended_reel: str
    concept: str
    hook: str
    sequence: list[FootageClipUse] = Field(default_factory=list, max_length=15)
    music_direction: str
    caption: str
    cta: str
    # The half that makes this practical: staff learn what to shoot before the
    # client leaves, not after the edit fails.
    missing_shots: list[MissingShot] = Field(default_factory=list, max_length=8)
    completeness: float = Field(ge=0, le=100)
    verdict: Literal["ready_to_edit", "usable_with_gaps", "needs_more_footage"]
    notes: str


# ── Capture checklist ───────────────────────────────────────────────────────


class CaptureTask(StrictModel):
    shot: str
    footage_type: Literal[
        "before", "wash", "cut", "color", "treatment", "styling",
        "after", "reaction", "detail", "bts", "product", "salon",
    ]
    duration_s: float = Field(gt=0, le=60)
    why: str


class CaptureDay(StrictModel):
    day: Literal["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    focus: str
    tasks: list[CaptureTask] = Field(min_length=1, max_length=8)


class CaptureChecklist(StrictModel):
    week_of: str
    days: list[CaptureDay] = Field(min_length=1, max_length=7)
    total_estimated_minutes: int = Field(ge=1, le=600)
    covers_content_items: int = Field(ge=0)
    notes: str


# ── Agent 14: Command Center ────────────────────────────────────────────────


class CommandStep(StrictModel):
    order: int = Field(ge=1)
    action: Literal[
        "generate_strategy", "generate_calendar", "generate_content",
        "research_trends", "analyze_competitors", "analyze_performance",
        "create_campaign", "generate_capture_checklist", "adjust_strategy",
    ]
    arguments: dict[str, str] = Field(default_factory=dict)
    rationale: str


class CommandPlan(StrictModel):
    understood_intent: str
    # Only genuinely blocking questions belong here. An agent that asks for
    # information it could infer from the brand brain is being unhelpful.
    clarifications: list[str] = Field(default_factory=list, max_length=3)
    steps: list[CommandStep] = Field(default_factory=list, max_length=10)
    expected_outcome: str


# ── Phase 3 contracts (schemas ship now, agents deferred) ───────────────────


class CommentClassification(StrictModel):
    classification: Literal[
        "positive", "question", "price_request", "booking_intent",
        "complaint", "spam", "negative", "needs_human",
    ]
    suggested_reply: str | None = None
    requires_human: bool
    reason: str


class DMClassification(StrictModel):
    intent: Literal["price", "booking", "service_question", "location", "hours", "other"]
    lead_intent: Literal["high", "medium", "low", "unknown"]
    score: float = Field(ge=0, le=100)
    requested_service: str | None = None
    suggested_reply: str | None = None
    escalate: bool
    reason: str
