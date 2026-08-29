"""The fourteen agents.

Each is a thin declaration over `agents.base.Agent`: a name, a tool name, an output
schema, a model tier, a system prompt and a user-prompt builder. All shared
machinery lives in the base class.
"""

from __future__ import annotations

import json
from typing import Any

from app.agents.base import Agent, AgentContext
from app.config import ModelTier
from app.prompts import analysis as analysis_prompts
from app.prompts import content as content_prompts
from app.prompts import strategy as strategy_prompts
from app.schemas.ai import (
    BrandStrategy,
    CaptionSet,
    CaptureChecklist,
    CarouselDraft,
    CommandPlan,
    CompetitorReport,
    ContentStrategy,
    FootageAnalysis,
    LearningUpdate,
    PerformanceAnalysis,
    QAReport,
    ReelDraft,
    StorySequence,
    TrendReport,
    ViralityAssessment,
)


def _block(ctx: AgentContext) -> str:
    """Brand + memory context, shared by every user prompt."""
    parts = [ctx.brand_block, ctx.memory_block]
    return "\n\n".join(p for p in parts if p)


def _extra(ctx: AgentContext, *keys: str) -> str:
    """Render selected context values as a labelled block."""
    lines = []
    for key in keys:
        value = ctx.extra.get(key)
        if value is None:
            continue
        rendered = json.dumps(value, indent=2, default=str) if isinstance(value, (dict, list)) else str(value)
        lines.append(f"{key.upper().replace('_', ' ')}:\n{rendered}")
    return "\n\n".join(lines)


# ── 1. Brand Strategist ─────────────────────────────────────────────────────


class BrandStrategist(Agent[BrandStrategy]):
    name = "brand_strategist"
    tool_name = "brand_strategy"
    task = "define_brand_strategy"
    tier = ModelTier.STRONG
    output_model = BrandStrategy
    system = strategy_prompts.BRAND_STRATEGIST_SYSTEM
    max_tokens = 6000

    def build_user_prompt(self, ctx: AgentContext) -> str:
        return (
            f"{_block(ctx)}\n\n"
            f"{_extra(ctx, 'competitors', 'research_notes')}\n\n"
            "Define this brand's positioning, tone system, audience model, visual direction and "
            "content pillars. Be explicit about what you do not know — list every missing fact "
            "that is limiting content quality in `information_gaps`."
        )


# ── 2. Trend Researcher ─────────────────────────────────────────────────────


class TrendResearcher(Agent[TrendReport]):
    name = "trend_researcher"
    tool_name = "trend_report"
    task = "research_trends"
    tier = ModelTier.BALANCED
    output_model = TrendReport
    system = strategy_prompts.TREND_RESEARCHER_SYSTEM
    max_tokens = 5000

    def build_user_prompt(self, ctx: AgentContext) -> str:
        return (
            f"{_block(ctx)}\n\n"
            f"{_extra(ctx, 'focus', 'current_month', 'season_notes', 'known_trends')}\n\n"
            "Identify the trends worth adopting for this brand right now, and explicitly reject "
            "the ones that would damage its positioning. For every trend, decide whether it can "
            "fit this brand naturally — and say so plainly when it cannot."
        )


# ── 3. Competitor Analyst ───────────────────────────────────────────────────


class CompetitorAnalyst(Agent[CompetitorReport]):
    name = "competitor_analyst"
    tool_name = "competitor_report"
    task = "analyze_competitors"
    tier = ModelTier.BALANCED
    output_model = CompetitorReport
    system = strategy_prompts.COMPETITOR_ANALYST_SYSTEM
    max_tokens = 5000

    def build_user_prompt(self, ctx: AgentContext) -> str:
        return (
            f"{_block(ctx)}\n\n"
            f"{_extra(ctx, 'competitors', 'competitor_posts')}\n\n"
            "Profile this competitive set, then identify the openings they are leaving. What can "
            "this brand own that they structurally cannot? Be concrete."
        )


# ── 4. Content Strategist ───────────────────────────────────────────────────


class ContentStrategist(Agent[ContentStrategy]):
    name = "content_strategist"
    tool_name = "content_strategy"
    task = "plan_cycle"
    tier = ModelTier.STRONG
    output_model = ContentStrategy
    system = strategy_prompts.CONTENT_STRATEGIST_SYSTEM
    max_tokens = 8000

    def build_user_prompt(self, ctx: AgentContext) -> str:
        return (
            f"{_block(ctx)}\n\n"
            f"{_extra(ctx, 'period', 'trends', 'competitor_gaps', 'performance_summary', 'emphasis')}\n\n"
            "Plan this content cycle: pillar mix, posting frequency, format split, objectives, "
            "themes, and a prioritised list of specific content ideas. Optimise for bookings, "
            "not views — justify any pure-reach idea explicitly."
        )


# ── 5. Reel Writer ──────────────────────────────────────────────────────────


class ReelWriter(Agent[ReelDraft]):
    name = "reel_writer"
    tool_name = "reel_draft"
    task = "write_reel"
    tier = ModelTier.BALANCED
    output_model = ReelDraft
    system = content_prompts.REEL_SYSTEM
    max_tokens = 5000

    def build_user_prompt(self, ctx: AgentContext) -> str:
        return (
            f"{_block(ctx)}\n\n"
            f"{_extra(ctx, 'brief', 'pillar', 'objective', 'topic', 'avoid_topics')}\n\n"
            "Write a complete, production-ready Reel. Every shot must be filmable during a normal "
            "appointment with a phone. The hook must work in the first three seconds."
        )


# ── 6. Carousel Writer ──────────────────────────────────────────────────────


class CarouselWriter(Agent[CarouselDraft]):
    name = "carousel_writer"
    tool_name = "carousel_draft"
    task = "write_carousel"
    tier = ModelTier.BALANCED
    output_model = CarouselDraft
    system = content_prompts.CAROUSEL_SYSTEM
    max_tokens = 5000

    def build_user_prompt(self, ctx: AgentContext) -> str:
        return (
            f"{_block(ctx)}\n\n"
            f"{_extra(ctx, 'brief', 'pillar', 'objective', 'topic', 'avoid_topics')}\n\n"
            "Write a complete carousel: cover, one idea per slide, and a CTA slide. It has to earn a save."
        )


# ── 7. Story Writer ─────────────────────────────────────────────────────────


class StoryWriter(Agent[StorySequence]):
    name = "story_writer"
    tool_name = "story_sequence"
    task = "write_stories"
    tier = ModelTier.CHEAP
    output_model = StorySequence
    system = content_prompts.STORY_SYSTEM
    max_tokens = 3000

    def build_user_prompt(self, ctx: AgentContext) -> str:
        return (
            f"{_block(ctx)}\n\n"
            f"{_extra(ctx, 'day', 'feed_topic', 'objective')}\n\n"
            "Write today's Story sequence. Connect it to the day's feed post where there is one."
        )


# ── 8. Caption Writer ───────────────────────────────────────────────────────


class CaptionWriter(Agent[CaptionSet]):
    name = "caption_writer"
    tool_name = "caption_set"
    task = "write_captions"
    tier = ModelTier.CHEAP
    output_model = CaptionSet
    system = content_prompts.CAPTION_SYSTEM
    max_tokens = 3000

    def build_user_prompt(self, ctx: AgentContext) -> str:
        return (
            f"{_block(ctx)}\n\n"
            f"{_extra(ctx, 'content_summary', 'hook', 'pillar', 'objective', 'cta')}\n\n"
            "Write three caption lengths for this content, plus hashtag groups and alt text."
        )


# ── 9. Virality Scorer ──────────────────────────────────────────────────────


class ViralityScorer(Agent[ViralityAssessment]):
    name = "virality_scorer"
    tool_name = "virality_assessment"
    task = "score_content"
    tier = ModelTier.BALANCED
    output_model = ViralityAssessment
    system = content_prompts.VIRALITY_SYSTEM
    max_tokens = 3000

    def build_user_prompt(self, ctx: AgentContext) -> str:
        return (
            f"{_block(ctx)}\n\n"
            f"{_extra(ctx, 'content')}\n\n"
            "Score this content on all twelve dimensions with a specific reason for each. Use the "
            "full range — an average idea should score average. Do not compute an overall score."
        )


# ── 10. QA Reviewer ─────────────────────────────────────────────────────────


class QAReviewer(Agent[QAReport]):
    name = "qa_reviewer"
    tool_name = "qa_report"
    task = "review_content"
    tier = ModelTier.BALANCED
    output_model = QAReport
    system = content_prompts.QA_SYSTEM
    max_tokens = 3000

    def build_user_prompt(self, ctx: AgentContext) -> str:
        return (
            f"{_block(ctx)}\n\n"
            f"{_extra(ctx, 'content', 'recent_topics', 'rule_scan_findings')}\n\n"
            "Review this content against every check. Block it if any blocking check fails. "
            "A deterministic rule scan has already run — its findings are included above and are "
            "authoritative; do not contradict them."
        )


# ── 11. Performance Analyst ─────────────────────────────────────────────────


class PerformanceAnalyst(Agent[PerformanceAnalysis]):
    name = "performance_analyst"
    tool_name = "performance_analysis"
    task = "analyze_performance"
    tier = ModelTier.STRONG
    output_model = PerformanceAnalysis
    system = analysis_prompts.ANALYTICS_SYSTEM
    max_tokens = 6000

    def build_user_prompt(self, ctx: AgentContext) -> str:
        return (
            f"{_block(ctx)}\n\n"
            f"{_extra(ctx, 'period_days', 'cohorts', 'top_posts', 'bottom_posts', 'totals')}\n\n"
            "Explain what this data means. Every finding must compare cohorts and explain the "
            "mechanism. Do not restate raw metrics. If there is not enough data, say so."
        )


# ── 12. Learning Agent ──────────────────────────────────────────────────────


class LearningAgent(Agent[LearningUpdate]):
    name = "learning_agent"
    tool_name = "learning_update"
    task = "update_memory"
    tier = ModelTier.STRONG
    output_model = LearningUpdate
    system = analysis_prompts.LEARNING_SYSTEM
    max_tokens = 4000

    def build_user_prompt(self, ctx: AgentContext) -> str:
        return (
            f"{_block(ctx)}\n\n"
            f"{_extra(ctx, 'analysis', 'existing_insights')}\n\n"
            "Convert this analysis into durable insights with evidence, confidence and expiry. "
            "Supersede any existing insight this contradicts. Be conservative with weight deltas."
        )


# ── 13. Footage Analyst ─────────────────────────────────────────────────────


class FootageAnalyst(Agent[FootageAnalysis]):
    name = "footage_analyst"
    tool_name = "footage_analysis"
    task = "analyze_footage"
    tier = ModelTier.BALANCED
    output_model = FootageAnalysis
    system = content_prompts.FOOTAGE_SYSTEM
    max_tokens = 4000

    def build_user_prompt(self, ctx: AgentContext) -> str:
        return (
            f"{_block(ctx)}\n\n"
            f"{_extra(ctx, 'clips', 'shoot_context')}\n\n"
            "Decide which Reel this footage can actually support, sequence it with real cut points, "
            "and tell staff exactly what they failed to film and why it matters."
        )


class CapturePlanner(Agent[CaptureChecklist]):
    name = "capture_planner"
    tool_name = "capture_checklist"
    task = "plan_capture"
    tier = ModelTier.BALANCED
    output_model = CaptureChecklist
    system = content_prompts.CAPTURE_SYSTEM
    max_tokens = 4000

    def build_user_prompt(self, ctx: AgentContext) -> str:
        return (
            f"{_block(ctx)}\n\n"
            f"{_extra(ctx, 'week_of', 'planned_content', 'footage_gaps')}\n\n"
            "Write this week's filming checklist for salon staff. Every task must be filmable "
            "during an appointment that is already happening."
        )


# ── 14. Command Center ──────────────────────────────────────────────────────


class CommandCenter(Agent[CommandPlan]):
    name = "command_center"
    tool_name = "command_plan"
    task = "interpret_command"
    tier = ModelTier.STRONG
    output_model = CommandPlan
    system = analysis_prompts.COMMAND_SYSTEM
    max_tokens = 3000

    def build_user_prompt(self, ctx: AgentContext) -> str:
        return (
            f"{_block(ctx)}\n\n"
            f"{_extra(ctx, 'command', 'current_state')}\n\n"
            "Interpret this request and produce an executable plan. Ask only genuinely blocking "
            "questions — prefer zero."
        )


AGENTS: dict[str, type[Agent[Any]]] = {
    cls.name: cls
    for cls in (
        BrandStrategist, TrendResearcher, CompetitorAnalyst, ContentStrategist,
        ReelWriter, CarouselWriter, StoryWriter, CaptionWriter,
        ViralityScorer, QAReviewer, PerformanceAnalyst, LearningAgent,
        FootageAnalyst, CapturePlanner, CommandCenter,
    )
}

__all__ = ["AGENTS", "Agent", "AgentContext", *[c.__name__ for c in AGENTS.values()]]
