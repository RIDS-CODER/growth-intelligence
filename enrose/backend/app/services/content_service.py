"""Content generation pipeline.

The full path a draft travels:

    duplicate check (free)  →  writer agent  →  virality scorer  →  rule scan (free)
    →  QA agent  →  status transition  →  persisted, with every AI call logged

Order matters. The two free checks bracket the expensive ones: duplicate detection
runs before any spend, and the deterministic rule scan runs before the QA agent so
its findings are handed to the reviewer as authoritative context.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agents import CaptionWriter, CarouselWriter, QAReviewer, ReelWriter, ViralityScorer
from app.agents.base import AgentContext
from app.enums import ActorType, ApprovalLevel, ContentFormat, ContentStatus
from app.llm.provider import LLMProvider
from app.models.brand import ContentPillar
from app.models.content import ContentIdea, ContentItem, ContentVariant
from app.schemas.ai import CarouselDraft, ReelDraft
from app.services import brand_service, content_status, memory, safety, virality


class GenerationRejected(RuntimeError):
    """Generation stopped before producing a publishable draft.

    Carries the reason so the API can tell the client *why* rather than returning a
    bare failure — a rejected duplicate and a rejected safety violation need
    different responses from the user.
    """

    def __init__(self, reason: str, stage: str, detail: dict[str, Any] | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.stage = stage
        self.detail = detail or {}


@dataclass
class GenerationResult:
    item: ContentItem
    cost_usd: float
    provider: str
    duplicate_similarity: float
    qa_passed: bool
    warnings: list[str]


def _agent_ctx(
    db: Session, client_id: uuid.UUID, brand_block: str, memory_block: str, **extra: Any
) -> AgentContext:
    return AgentContext(
        client_id=client_id, db=db, brand_block=brand_block, memory_block=memory_block, extra=extra
    )


def _pick_pillar(db: Session, client_id: uuid.UUID, requested: str | None) -> str:
    """Use the requested pillar, else the heaviest active one."""
    if requested:
        return requested
    pillar = db.execute(
        select(ContentPillar)
        .where(ContentPillar.client_id == client_id, ContentPillar.is_active.is_(True))
        .order_by(ContentPillar.weight.desc())
    ).scalars().first()
    return pillar.key if pillar else "transformation"


def generate_content(
    db: Session,
    client_id: uuid.UUID,
    *,
    content_format: ContentFormat = ContentFormat.REEL,
    pillar: str | None = None,
    topic: str | None = None,
    objective: str | None = None,
    brief: str | None = None,
    idea_id: uuid.UUID | None = None,
    strategy_id: uuid.UUID | None = None,
    campaign_id: uuid.UUID | None = None,
    provider: LLMProvider | None = None,
    skip_duplicate_check: bool = False,
) -> GenerationResult:
    """Generate one piece of content, end to end."""
    if content_format not in (ContentFormat.REEL, ContentFormat.CAROUSEL):
        raise GenerationRejected(
            f"Format '{content_format.value}' is not generated through this pipeline. "
            "Reels and carousels only; stories are generated per day via the story engine.",
            stage="input",
        )

    brand = brand_service.build_brand_dict(db, client_id)
    if not brand:
        raise GenerationRejected("No Brand Brain exists for this client.", stage="input")

    brand_block = brand_service.build_brand_block(db, client_id)
    memory_block = brand_service.build_memory_block(db, client_id)
    chosen_pillar = _pick_pillar(db, client_id, pillar)
    warnings: list[str] = []
    total_cost = 0.0

    # ── Stage 1: duplicate check (free, before any spend) ───────────────────
    duplicate_similarity = 0.0
    if topic and not skip_duplicate_check:
        dup = memory.check_duplicate(db, client_id, topic)
        duplicate_similarity = dup.similarity
        if dup.is_duplicate:
            raise GenerationRejected(
                dup.reason or "Topic too similar to previous content.",
                stage="duplicate_check",
                detail={"similarity": dup.similarity, "matched_topic": dup.matched_topic},
            )

    recent = memory.recent_topics(db, client_id, limit=30)

    # ── Stage 2: write the draft ────────────────────────────────────────────
    ctx = _agent_ctx(
        db, client_id, brand_block, memory_block,
        brief=brief, pillar=chosen_pillar, objective=objective, topic=topic,
        avoid_topics=recent,
    )

    if content_format is ContentFormat.REEL:
        writer_result = ReelWriter(provider=provider).run(ctx)
        draft: ReelDraft | CarouselDraft = writer_result.output
        payload = draft.model_dump(mode="json")
        title = draft.title
        hook = draft.hook
        caption = draft.caption
        cta = draft.cta
        hashtags = draft.hashtags
        draft_objective = draft.objective
        draft_pillar = draft.pillar
    else:
        writer_result = CarouselWriter(provider=provider).run(ctx)
        draft = writer_result.output
        payload = draft.model_dump(mode="json")
        title = draft.title
        hook = draft.hook
        caption = draft.caption
        cta = draft.cta
        hashtags = draft.hashtags
        draft_objective = draft.objective
        draft_pillar = draft.pillar

    total_cost += writer_result.cost_usd
    provider_name = writer_result.provider

    # The writer may pick a different topic than requested, so re-check against memory.
    if not skip_duplicate_check:
        dup = memory.check_duplicate(db, client_id, title)
        duplicate_similarity = max(duplicate_similarity, dup.similarity)
        if dup.is_duplicate:
            raise GenerationRejected(
                dup.reason or "Generated topic duplicates existing content.",
                stage="duplicate_check_post",
                detail={"similarity": dup.similarity, "matched_topic": dup.matched_topic},
            )

    item = ContentItem(
        client_id=client_id,
        title=title,
        format=content_format.value,
        pillar=draft_pillar or chosen_pillar,
        objective=draft_objective or objective,
        status=ContentStatus.IDEA.value,
        hook=hook,
        caption=caption,
        cta=cta,
        hashtags=hashtags,
        payload=payload,
        strategy_id=strategy_id,
        campaign_id=campaign_id,
        idea_id=idea_id,
        approval_level=ApprovalLevel.L1_HUMAN_REQUIRED.value,
    )
    db.add(item)
    db.flush()
    content_status.transition(
        db, item, ContentStatus.DRAFT, actor_type=ActorType.AGENT,
        actor_label="reel_writer" if content_format is ContentFormat.REEL else "carousel_writer",
    )

    ctx.content_item_id = item.id

    # ── Stage 3: virality scoring ───────────────────────────────────────────
    score_ctx = _agent_ctx(db, client_id, brand_block, memory_block, content=payload)
    score_ctx.content_item_id = item.id
    score_result = ViralityScorer(provider=provider).run(score_ctx)
    total_cost += score_result.cost_usd
    scores = virality.roll_up(score_result.output)
    item.viral_score = scores.viral_score
    item.business_score = scores.business_score
    item.overall_score = scores.overall_score
    item.score_breakdown = scores.breakdown

    content_status.transition(
        db, item, ContentStatus.AI_REVIEW, actor_type=ActorType.AGENT, actor_label="virality_scorer"
    )

    # ── Stage 4: deterministic rule scan (free, authoritative) ──────────────
    scan = safety.scan_content_item(
        payload,
        known_services=brand_service.known_service_names(brand),
        known_products=brand_service.known_product_names(brand),
    )

    # ── Stage 5: QA agent, given the scan findings as context ───────────────
    qa_ctx = _agent_ctx(
        db, client_id, brand_block, memory_block,
        content=payload, recent_topics=recent, rule_scan_findings=scan.to_dict(),
    )
    qa_ctx.content_item_id = item.id
    qa_result = QAReviewer(provider=provider).run(qa_ctx)
    total_cost += qa_result.cost_usd
    qa_report = qa_result.output

    # The rule scan wins. A model cannot approve away a deterministic violation.
    blocking_reasons = list(qa_report.blocking_reasons)
    for finding in scan.blocking:
        blocking_reasons.append(f"[rule:{finding.rule}] {finding.detail} — found: '{finding.excerpt}'")

    quality_ok, quality_reason = virality.meets_quality_bar(scores)
    if not quality_ok and quality_reason:
        warnings.append(quality_reason)

    item.qa_report = {
        **qa_report.model_dump(mode="json"),
        "rule_scan": scan.to_dict(),
        "blocking_reasons": blocking_reasons,
        "quality_bar_passed": quality_ok,
    }

    qa_passed = qa_report.approved and scan.passed and quality_ok

    if not qa_passed:
        content_status.transition(
            db, item, ContentStatus.REJECTED, actor_type=ActorType.AGENT, actor_label="qa_reviewer",
            note="; ".join(blocking_reasons or [quality_reason or "failed QA"])[:1000],
        )
        db.commit()
        raise GenerationRejected(
            "Draft failed quality control and was rejected automatically.",
            stage="qa",
            detail={
                "content_item_id": str(item.id),
                "blocking_reasons": blocking_reasons,
                "quality_reason": quality_reason,
                "scores": scores.as_dict(),
            },
        )

    content_status.transition(
        db, item, ContentStatus.READY_FOR_APPROVAL, actor_type=ActorType.AGENT, actor_label="qa_reviewer"
    )

    memory.record(
        db, client_id, topic=title, pillar=item.pillar, content_format=content_format.value,
        hook=hook, content_item_id=item.id,
    )

    if idea_id:
        idea = db.get(ContentIdea, idea_id)
        if idea is not None:
            idea.status = "promoted"
            idea.promoted_content_item_id = item.id

    db.commit()
    db.refresh(item)
    return GenerationResult(
        item=item,
        cost_usd=round(total_cost, 6),
        provider=provider_name,
        duplicate_similarity=duplicate_similarity,
        qa_passed=True,
        warnings=warnings,
    )


def generate_captions(
    db: Session, client_id: uuid.UUID, item: ContentItem, *, provider: LLMProvider | None = None
) -> tuple[list[ContentVariant], float]:
    """Regenerate caption options for existing content.

    Separate from the creative pass so captions can be reworked cheaply without
    paying for a whole new reel.
    """
    brand = brand_service.build_brand_dict(db, client_id)
    ctx = _agent_ctx(
        db, client_id,
        brand_service.build_brand_block(db, client_id),
        brand_service.build_memory_block(db, client_id),
        content_summary=item.payload.get("concept") or item.title,
        hook=item.hook, pillar=item.pillar, objective=item.objective, cta=item.cta,
    )
    ctx.content_item_id = item.id
    result = CaptionWriter(provider=provider).run(ctx)
    caption_set = result.output

    scan = safety.scan_content_item(
        caption_set.model_dump(mode="json"),
        known_services=brand_service.known_service_names(brand),
        known_products=brand_service.known_product_names(brand),
    )
    if not scan.passed:
        raise GenerationRejected(
            "Generated captions failed the safety rule scan.",
            stage="caption_safety",
            detail=scan.to_dict(),
        )

    # Replace previous caption options rather than accumulating them.
    for existing in list(item.variants):
        if existing.kind == "caption":
            db.delete(existing)
    db.flush()

    variants: list[ContentVariant] = []
    for i, variant in enumerate(caption_set.variants):
        row = ContentVariant(
            client_id=client_id,
            content_item_id=item.id,
            kind="caption",
            label=variant.label,
            body=variant.body,
            is_selected=(i == 0),
            meta={
                "hook_line": caption_set.hook_line,
                "cta": caption_set.cta,
                "hashtags_broad": caption_set.hashtags_broad,
                "hashtags_niche": caption_set.hashtags_niche,
                "hashtags_local": caption_set.hashtags_local,
                "alt_text": caption_set.alt_text,
            },
        )
        db.add(row)
        variants.append(row)

    if variants:
        item.caption = variants[0].body
        item.cta = caption_set.cta
        item.hashtags = (
            caption_set.hashtags_broad + caption_set.hashtags_niche + caption_set.hashtags_local
        )

    db.commit()
    return variants, result.cost_usd
