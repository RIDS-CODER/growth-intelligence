"""Raw footage engine and the weekly capture checklist.

The half of the product that survives contact with a busy salon: staff film during
appointments they are already doing, and the system works out what can be built
from it — and what they forgot to shoot.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agents import CapturePlanner, FootageAnalyst
from app.agents.base import AgentContext
from app.enums import FootageType
from app.llm.provider import LLMProvider
from app.models.content import Asset, ContentAsset, ContentItem
from app.services import brand_service

# The arc a transformation reel needs. Gaps here are what the missing-shot report
# is checking for, before the model is even consulted.
TRANSFORMATION_ARC: list[FootageType] = [
    FootageType.BEFORE,
    FootageType.COLOR,
    FootageType.STYLING,
    FootageType.AFTER,
    FootageType.REACTION,
]


def _ctx(db: Session, client_id: uuid.UUID, **extra: Any) -> AgentContext:
    return AgentContext(
        client_id=client_id,
        db=db,
        brand_block=brand_service.build_brand_block(db, client_id),
        memory_block=brand_service.build_memory_block(db, client_id),
        extra=extra,
    )


def coverage_report(assets: list[Asset]) -> dict[str, Any]:
    """Deterministic coverage check, before any model call.

    Cheap and honest: if the emotional payoff shots are missing, that is a fact
    about the file list, not a judgement call.
    """
    present = {a.footage_type for a in assets}
    missing_arc = [ft.value for ft in TRANSFORMATION_ARC if ft.value not in present]
    covered = len(TRANSFORMATION_ARC) - len(missing_arc)
    return {
        "clips": len(assets),
        "types_present": sorted(present),
        "arc_missing": missing_arc,
        "arc_coverage_pct": round(100 * covered / len(TRANSFORMATION_ARC), 1),
        "total_duration_s": round(sum(a.duration_s or 0 for a in assets), 1),
        "has_payoff": FootageType.AFTER.value in present,
        "has_reaction": FootageType.REACTION.value in present,
    }


def analyze_footage(
    db: Session,
    client_id: uuid.UUID,
    *,
    asset_ids: list[uuid.UUID] | None = None,
    shoot_group: str | None = None,
    provider: LLMProvider | None = None,
) -> tuple[dict[str, Any], float]:
    """Turn uploaded clips into a reel plan plus a missing-shot report."""
    query = select(Asset).where(Asset.client_id == client_id)
    if asset_ids:
        query = query.where(Asset.id.in_(asset_ids))
    elif shoot_group:
        query = query.where(Asset.shoot_group == shoot_group)
    else:
        query = query.where(Asset.kind == "video").order_by(Asset.created_at.desc()).limit(12)

    assets = list(db.execute(query).scalars().all())
    if not assets:
        raise ValueError("No footage found to analyse. Upload clips first.")

    coverage = coverage_report(assets)
    clips = [
        {
            "asset_id": str(a.id),
            "filename": a.filename,
            "footage_type": a.footage_type,
            "duration_s": a.duration_s,
            "notes": a.notes,
        }
        for a in assets
    ]

    ctx = _ctx(db, client_id, clips=clips, shoot_context=coverage)
    result = FootageAnalyst(provider=provider).run(ctx)
    analysis = result.output

    # The model may reference asset ids loosely; only keep steps that name a real clip.
    valid_ids = {str(a.id) for a in assets}
    sequence = [
        step.model_dump(mode="json")
        for step in analysis.sequence
        if step.asset_id in valid_ids
    ]

    payload = {
        **analysis.model_dump(mode="json"),
        "sequence": sequence,
        "sequence_dropped": len(analysis.sequence) - len(sequence),
        "coverage": coverage,
        "provider": result.provider,
    }

    for asset in assets:
        asset.analysis = {"last_analysis": payload["recommended_reel"], "coverage": coverage}
    db.commit()

    return payload, result.cost_usd


def attach_assets(
    db: Session,
    client_id: uuid.UUID,
    content_item_id: uuid.UUID,
    asset_ids: list[uuid.UUID],
    *,
    role: str = "broll",
) -> list[ContentAsset]:
    """Attach uploaded footage to a content item."""
    item = db.execute(
        select(ContentItem).where(
            ContentItem.id == content_item_id, ContentItem.client_id == client_id
        )
    ).scalar_one_or_none()
    if item is None:
        raise ValueError("Content item not found")

    assets = list(
        db.execute(
            select(Asset).where(Asset.id.in_(asset_ids), Asset.client_id == client_id)
        ).scalars().all()
    )
    found = {a.id for a in assets}
    missing = [str(a) for a in asset_ids if a not in found]
    if missing:
        raise ValueError(f"Assets not found for this client: {', '.join(missing)}")

    existing = {
        link.asset_id
        for link in db.execute(
            select(ContentAsset).where(ContentAsset.content_item_id == item.id)
        ).scalars().all()
    }

    start = len(existing)
    links: list[ContentAsset] = []
    for offset, asset in enumerate(assets):
        if asset.id in existing:
            continue
        link = ContentAsset(
            client_id=client_id,
            content_item_id=item.id,
            asset_id=asset.id,
            role=role,
            position=start + offset,
        )
        db.add(link)
        links.append(link)

    db.commit()
    for link in links:
        db.refresh(link)
    return links


def generate_capture_checklist(
    db: Session, client_id: uuid.UUID, *, week_of: str | None = None, provider: LLMProvider | None = None
) -> tuple[dict[str, Any], float]:
    """Tell staff exactly what to film this week."""
    from datetime import date

    planned = db.execute(
        select(ContentItem)
        .where(ContentItem.client_id == client_id, ContentItem.scheduled_for.isnot(None))
        .order_by(ContentItem.scheduled_for)
        .limit(20)
    ).scalars().all()

    recent_assets = list(
        db.execute(
            select(Asset).where(Asset.client_id == client_id).order_by(Asset.created_at.desc()).limit(30)
        ).scalars().all()
    )
    gaps = coverage_report(recent_assets) if recent_assets else {"arc_missing": [ft.value for ft in TRANSFORMATION_ARC]}

    ctx = _ctx(
        db, client_id,
        week_of=week_of or date.today().isoformat(),
        planned_content=[
            {"title": i.title, "format": i.format, "pillar": i.pillar} for i in planned
        ],
        footage_gaps=gaps,
    )
    result = CapturePlanner(provider=provider).run(ctx)
    return {**result.output.model_dump(mode="json"), "footage_gaps": gaps}, result.cost_usd
