"""Strategy generation and the guard-railed application of learned deltas."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agents import BrandStrategist, CompetitorAnalyst, ContentStrategist, TrendResearcher
from app.agents.base import AgentContext
from app.llm.provider import LLMProvider
from app.models.brand import Audience, Brand, ContentPillar
from app.models.content import ContentIdea, Strategy
from app.models.research import Trend
from app.services import brand_service

# A single cycle may not move a pillar's weight by more than this. One lucky viral
# reel should nudge the strategy, not hijack it.
MAX_WEIGHT_DELTA_PER_CYCLE = 0.08


def _ctx(db: Session, client_id: uuid.UUID, **extra: Any) -> AgentContext:
    return AgentContext(
        client_id=client_id,
        db=db,
        brand_block=brand_service.build_brand_block(db, client_id),
        memory_block=brand_service.build_memory_block(db, client_id),
        extra=extra,
    )


def generate_brand_strategy(
    db: Session, client_id: uuid.UUID, *, provider: LLMProvider | None = None
) -> tuple[Brand, float]:
    """Run the Brand Strategist and write its output back into the Brand Brain."""
    brand = brand_service.get_brand(db, client_id)
    if brand is None:
        raise ValueError("No brand exists for this client")

    ctx = _ctx(db, client_id, competitors=brand_service.list_competitors(db, client_id))
    result = BrandStrategist(provider=provider).run(ctx)
    out = result.output

    brand.positioning = out.positioning
    brand.tone = {
        "rules": out.tone_rules,
        "words_to_favour": out.words_to_favour,
    }
    brand.visual_identity = {**(brand.visual_identity or {}), "direction": out.visual_direction}
    # Union rather than overwrite: client-entered avoidances must survive a regeneration.
    brand.words_to_avoid = sorted(set(brand.words_to_avoid or []) | set(out.words_to_avoid))
    brand.business_goals = [{"goal": g} for g in out.strategic_objectives]
    brand.unknown_fields = sorted(set(brand.unknown_fields or []) | set(out.information_gaps))

    _sync_audiences(db, brand, out.audiences)
    _sync_pillars(db, client_id, out.pillars)

    db.commit()
    db.refresh(brand)
    brand_service.compute_completeness(db, client_id)
    db.commit()
    return brand, result.cost_usd


def _sync_audiences(db: Session, brand: Brand, proposals) -> None:
    existing = {a.segment.lower(): a for a in brand.audiences}
    for proposal in proposals:
        row = existing.get(proposal.segment.lower())
        if row is None:
            row = Audience(client_id=brand.client_id, brand_id=brand.id, segment=proposal.segment)
            db.add(row)
        row.demographics = proposal.demographics
        row.pains = proposal.pains
        row.desires = proposal.desires
        row.priority = proposal.priority
        row.confidence = proposal.confidence
    db.flush()


def _sync_pillars(db: Session, client_id: uuid.UUID, proposals) -> None:
    """Pillars are data: the strategist may add, reweight or retire them."""
    existing = {
        p.key: p
        for p in db.execute(
            select(ContentPillar).where(ContentPillar.client_id == client_id)
        ).scalars().all()
    }
    proposed_keys = set()
    for proposal in proposals:
        proposed_keys.add(proposal.key)
        row = existing.get(proposal.key)
        if row is None:
            row = ContentPillar(client_id=client_id, key=proposal.key, source="ai_discovered")
            db.add(row)
        row.label = proposal.label
        row.description = proposal.description
        row.objective = proposal.objective
        row.weight = proposal.weight
        row.examples = proposal.examples
        row.is_active = True
    # A pillar the strategist dropped is deactivated, never deleted — its history
    # and its performance record stay intact.
    for key, row in existing.items():
        if key not in proposed_keys:
            row.is_active = False
    db.flush()


def generate_content_strategy(
    db: Session,
    client_id: uuid.UUID,
    *,
    period_start: date | None = None,
    period_days: int = 30,
    emphasis: str | None = None,
    provider: LLMProvider | None = None,
) -> tuple[Strategy, float]:
    """Plan a content cycle and store its ideas as a backlog."""
    start = period_start or date.today()
    end = start + timedelta(days=period_days - 1)

    trends = db.execute(
        select(Trend)
        .where(Trend.client_id == client_id, Trend.fits_brand.is_(True))
        .order_by(Trend.relevance_score.desc())
        .limit(10)
    ).scalars().all()

    ctx = _ctx(
        db, client_id,
        period=f"{start.isoformat()} to {end.isoformat()}",
        trends=[{"name": t.name, "category": t.category, "adaptation": t.recommended_adaptation} for t in trends],
        emphasis=emphasis,
    )
    result = ContentStrategist(provider=provider).run(ctx)
    out = result.output

    strategy = Strategy(
        client_id=client_id,
        title=out.title,
        period_start=start,
        period_end=end,
        pillar_mix=out.pillar_mix,
        posting_frequency=out.posting_frequency,
        format_split=out.format_split,
        objectives=[o.model_dump(mode="json") for o in out.objectives],
        audience_focus=out.audience_focus,
        themes=out.themes,
        rationale=out.rationale,
        derived_from_insights=[i["id"] for i in brand_service.active_insights(db, client_id)],
        status="active",
    )
    db.add(strategy)
    db.flush()

    # Supersede the previous active strategy for the same period.
    for other in db.execute(
        select(Strategy).where(
            Strategy.client_id == client_id, Strategy.status == "active", Strategy.id != strategy.id
        )
    ).scalars().all():
        other.status = "superseded"

    for idea in out.ideas:
        db.add(
            ContentIdea(
                client_id=client_id,
                title=idea.title,
                pillar=idea.pillar,
                format=idea.format,
                objective=idea.objective,
                hook=idea.hook,
                summary=idea.summary,
                source="content_strategist",
                status="open",
            )
        )

    db.commit()
    db.refresh(strategy)
    return strategy, result.cost_usd


def research_trends(
    db: Session, client_id: uuid.UUID, *, focus: str | None = None, provider: LLMProvider | None = None
) -> tuple[list[Trend], float]:
    ctx = _ctx(db, client_id, focus=focus, current_month=date.today().strftime("%B %Y"))
    result = TrendResearcher(provider=provider).run(ctx)

    rows: list[Trend] = []
    for item in result.output.trends:
        row = Trend(
            client_id=client_id,
            name=item.name,
            category=item.category,
            description=item.description,
            source="trend_researcher",
            detected_on=date.today(),
            popularity=item.popularity,
            relevance_score=item.relevance_score,
            expiry_probability=item.expiry_probability,
            fits_brand=item.fits_brand,
            fit_reason=item.fit_reason,
            recommended_adaptation=item.recommended_adaptation,
            # A rejected trend is kept, with its reason, so it is not re-proposed.
            status="rejected" if item.recommended_action == "ignore" else "detected",
        )
        db.add(row)
        rows.append(row)

    db.commit()
    return rows, result.cost_usd


def analyze_competitors(
    db: Session, client_id: uuid.UUID, *, provider: LLMProvider | None = None
) -> tuple[dict[str, Any], float]:
    from datetime import datetime, timezone

    from app.models.brand import Competitor

    competitors = brand_service.list_competitors(db, client_id)
    ctx = _ctx(db, client_id, competitors=competitors)
    result = CompetitorAnalyst(provider=provider).run(ctx)

    now = datetime.now(timezone.utc)
    for row in db.execute(
        select(Competitor).where(Competitor.client_id == client_id)
    ).scalars().all():
        row.last_analyzed_at = now

    db.commit()
    return result.output.model_dump(mode="json"), result.cost_usd


def apply_pillar_deltas(
    db: Session, client_id: uuid.UUID, deltas: dict[str, float]
) -> dict[str, dict[str, float]]:
    """Apply learned weight deltas, capped and renormalised.

    The cap is the guard-rail that keeps the learning loop stable: without it, a
    single strong cycle would swing the whole strategy and the account would
    oscillate instead of converging.
    """
    pillars = db.execute(
        select(ContentPillar).where(
            ContentPillar.client_id == client_id, ContentPillar.is_active.is_(True)
        )
    ).scalars().all()
    if not pillars:
        return {}

    changes: dict[str, dict[str, float]] = {}
    for pillar in pillars:
        raw = deltas.get(pillar.key, 0.0)
        capped = max(-MAX_WEIGHT_DELTA_PER_CYCLE, min(MAX_WEIGHT_DELTA_PER_CYCLE, raw))
        before = pillar.weight
        pillar.weight = max(0.01, before + capped)
        if raw != 0.0:
            changes[pillar.key] = {
                "before": round(before, 4),
                "requested": round(raw, 4),
                "applied": round(capped, 4),
                "after": round(pillar.weight, 4),
            }

    total = sum(p.weight for p in pillars)
    if total > 0:
        for pillar in pillars:
            pillar.weight = round(pillar.weight / total, 4)
    for key, change in changes.items():
        match = next((p for p in pillars if p.key == key), None)
        if match:
            change["normalised"] = match.weight

    db.commit()
    return changes
