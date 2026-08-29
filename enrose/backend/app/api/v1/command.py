"""AI Command Center, dashboard aggregate, and leads.

The command endpoint does not merely describe a plan — with `execute=true` it runs
the plan's steps against the real services. A plan that cannot be executed is a
chat transcript, not a product.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agents import CommandCenter
from app.agents.base import AgentContext
from app.db import get_db
from app.enums import ContentFormat, ContentStatus
from app.models.analytics import AIInsight
from app.models.content import CalendarEntry, ContentItem
from app.models.engagement import Lead
from app.models.research import Trend
from app.schemas.api import CommandRequest, CommandResponse
from app.security import TenantContext, get_tenant
from app.services import (
    analytics_service,
    approval_service,
    brand_service,
    calendar_service,
    content_service,
    footage_service,
    strategy_service,
)

router = APIRouter(tags=["command"])


def _execute_step(db: Session, client_id, action: str, args: dict[str, str]) -> dict[str, Any]:
    """Run one planned step against the real services."""
    if action == "generate_strategy":
        strategy, cost = strategy_service.generate_content_strategy(
            db, client_id, emphasis=args.get("emphasis")
        )
        return {"action": action, "ok": True, "strategy_id": str(strategy.id), "cost_usd": cost}

    if action == "adjust_strategy":
        strategy, cost = strategy_service.generate_content_strategy(
            db, client_id, emphasis=args.get("bias") or args.get("emphasis")
        )
        return {"action": action, "ok": True, "strategy_id": str(strategy.id), "cost_usd": cost}

    if action == "generate_calendar":
        weeks = int(args.get("weeks", 4) or 4)
        plan = calendar_service.generate_calendar(db, client_id, days=weeks * 7)
        return {"action": action, "ok": True, "entries": len(plan.entries), "counts": plan.counts}

    if action == "generate_content":
        count = min(int(args.get("count", 3) or 3), 8)
        fmt = ContentFormat(args.get("format", "reel")) if args.get("format") else ContentFormat.REEL
        created, rejected, cost = [], [], 0.0
        for _ in range(count):
            try:
                result = content_service.generate_content(db, client_id, content_format=fmt)
                created.append(str(result.item.id))
                cost += result.cost_usd
            except content_service.GenerationRejected as exc:
                rejected.append(exc.reason)
        return {
            "action": action, "ok": bool(created), "created": created,
            "rejected": rejected, "cost_usd": round(cost, 6),
        }

    if action == "research_trends":
        trends, cost = strategy_service.research_trends(db, client_id, focus=args.get("focus"))
        return {"action": action, "ok": True, "detected": len(trends), "cost_usd": cost}

    if action == "analyze_competitors":
        report, cost = strategy_service.analyze_competitors(db, client_id)
        return {"action": action, "ok": True, "gaps": report.get("exploitable_gaps", []), "cost_usd": cost}

    if action == "analyze_performance":
        days = int(args.get("days", 30) or 30)
        result, cost = analytics_service.analyze_performance(db, client_id, days=days)
        return {
            "action": action, "ok": True,
            "headline": result["analysis"].get("headline_recommendation"), "cost_usd": cost,
        }

    if action == "generate_capture_checklist":
        checklist, cost = footage_service.generate_capture_checklist(db, client_id)
        return {"action": action, "ok": True, "days": len(checklist.get("days", [])), "cost_usd": cost}

    if action == "create_campaign":
        from app.models.content import Campaign

        campaign = Campaign(
            client_id=client_id,
            name=args.get("name", "Untitled campaign"),
            goal=args.get("goal"),
            status="planned",
        )
        db.add(campaign)
        db.commit()
        db.refresh(campaign)
        return {"action": action, "ok": True, "campaign_id": str(campaign.id)}

    return {"action": action, "ok": False, "error": f"Unknown action '{action}'"}


@router.post("/command", response_model=CommandResponse)
def command(
    payload: CommandRequest,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> CommandResponse:
    """Interpret a natural-language instruction, and optionally carry it out."""
    ctx = AgentContext(
        client_id=tenant.client_id,
        db=db,
        brand_block=brand_service.build_brand_block(db, tenant.client_id),
        memory_block=brand_service.build_memory_block(db, tenant.client_id),
        extra={
            "command": payload.command,
            "current_state": {
                "content_items": db.query(ContentItem)
                .filter(ContentItem.client_id == tenant.client_id)
                .count(),
                "pending_approval": len(approval_service.approval_queue(db, tenant.client_id)),
            },
        },
    )
    result = CommandCenter().run(ctx)
    plan = result.output
    executed: list[dict[str, Any]] = []

    # Blocking questions stop execution — acting on a misunderstood instruction is
    # worse than asking.
    if payload.execute and not plan.clarifications:
        for step in sorted(plan.steps, key=lambda s: s.order):
            try:
                executed.append(_execute_step(db, tenant.client_id, step.action, step.arguments))
            except Exception as exc:  # noqa: BLE001 - report, don't abort the whole plan
                executed.append({"action": step.action, "ok": False, "error": str(exc)[:300]})

    return CommandResponse(
        plan=plan.model_dump(mode="json"),
        executed=executed,
        cost_usd=result.cost_usd,
        provider=result.provider,
    )


@router.get("/dashboard")
def dashboard(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> dict:
    """Everything the home screen needs, in one round trip."""
    client_id = tenant.client_id
    now = datetime.now(timezone.utc)
    day_end = now + timedelta(days=1)
    month_start = now - timedelta(days=30)

    today = list(
        db.execute(
            select(CalendarEntry)
            .where(
                CalendarEntry.client_id == client_id,
                CalendarEntry.scheduled_for >= now - timedelta(hours=12),
                CalendarEntry.scheduled_for <= day_end,
            )
            .order_by(CalendarEntry.scheduled_for)
        ).scalars().all()
    )

    upcoming = list(
        db.execute(
            select(CalendarEntry)
            .where(CalendarEntry.client_id == client_id, CalendarEntry.scheduled_for > day_end)
            .order_by(CalendarEntry.scheduled_for)
            .limit(8)
        ).scalars().all()
    )

    queue = approval_service.approval_queue(db, client_id, limit=10)

    # The headline recommendation: the highest-scoring approvable draft.
    recommendation = None
    best = db.execute(
        select(ContentItem)
        .where(
            ContentItem.client_id == client_id,
            ContentItem.status.in_(
                [ContentStatus.READY_FOR_APPROVAL.value, ContentStatus.CLIENT_APPROVED.value]
            ),
        )
        .order_by(ContentItem.overall_score.desc().nullslast())
    ).scalars().first()
    if best is not None:
        recommendation = {
            "content_item_id": str(best.id),
            "title": best.title,
            "format": best.format,
            "pillar": best.pillar,
            "hook": best.hook,
            "viral_score": best.viral_score,
            "business_score": best.business_score,
            "overall_score": best.overall_score,
            "why": (best.score_breakdown or {}).get("explanation"),
        }

    produced = db.execute(
        select(ContentItem.format, ContentItem.status).where(
            ContentItem.client_id == client_id, ContentItem.created_at >= month_start
        )
    ).all()
    month_counts: dict[str, int] = {}
    for fmt, _ in produced:
        month_counts[fmt] = month_counts.get(fmt, 0) + 1

    pipeline: dict[str, int] = {}
    for status in db.execute(
        select(ContentItem.status).where(ContentItem.client_id == client_id)
    ).scalars().all():
        pipeline[status] = pipeline.get(status, 0) + 1

    latest_insight = db.execute(
        select(AIInsight)
        .where(AIInsight.client_id == client_id, AIInsight.is_active.is_(True))
        .order_by(AIInsight.created_at.desc())
    ).scalars().first()

    trend_alerts = [
        {"id": str(t.id), "name": t.name, "relevance_score": t.relevance_score,
         "recommended_adaptation": t.recommended_adaptation}
        for t in db.execute(
            select(Trend)
            .where(
                Trend.client_id == client_id,
                Trend.fits_brand.is_(True),
                Trend.status == "detected",
            )
            .order_by(Trend.relevance_score.desc())
            .limit(3)
        ).scalars().all()
    ]

    lead_alerts = [
        {"id": str(lead.id), "handle": lead.handle, "intent": lead.intent,
         "requested_service": lead.requested_service, "message": lead.message}
        for lead in db.execute(
            select(Lead)
            .where(Lead.client_id == client_id, Lead.status == "new")
            .order_by(Lead.score.desc())
            .limit(5)
        ).scalars().all()
    ]

    analytics = analytics_service.summary(db, client_id, 30)
    completeness, missing = brand_service.compute_completeness(db, client_id)
    db.commit()

    return {
        "client": {"id": str(client_id), "name": tenant.client.name},
        "recommendation": recommendation,
        "today": [
            {"id": str(e.id), "scheduled_for": e.scheduled_for.isoformat(), "format": e.format,
             "pillar": e.pillar, "topic": e.topic, "status": e.status}
            for e in today
        ],
        "upcoming": [
            {"id": str(e.id), "scheduled_for": e.scheduled_for.isoformat(), "format": e.format,
             "pillar": e.pillar, "topic": e.topic, "status": e.status}
            for e in upcoming
        ],
        "approval_queue": [
            {"id": str(i.id), "title": i.title, "format": i.format, "pillar": i.pillar,
             "overall_score": i.overall_score, "hook": i.hook}
            for i in queue
        ],
        "month_production": month_counts,
        "pipeline": pipeline,
        "latest_insight": (
            {
                "id": str(latest_insight.id), "title": latest_insight.title,
                "body": latest_insight.body, "recommendation": latest_insight.recommendation,
                "confidence": latest_insight.confidence,
            }
            if latest_insight
            else None
        ),
        "trend_alerts": trend_alerts,
        "lead_alerts": lead_alerts,
        "performance": {
            "n_posts": analytics.get("n_posts", 0),
            "totals": analytics.get("totals", {}),
            "top_posts": analytics.get("top_posts", []),
            "by_pillar": analytics.get("by_pillar", []),
        },
        "brand_completeness": {"score": completeness, "missing": missing},
    }


@router.get("/leads")
def list_leads(
    limit: int = Query(default=50, ge=1, le=200),
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> list[dict]:
    rows = db.execute(
        select(Lead)
        .where(Lead.client_id == tenant.client_id)
        .order_by(Lead.score.desc(), Lead.created_at.desc())
        .limit(limit)
    ).scalars().all()
    return [
        {
            "id": str(lead.id), "handle": lead.handle, "name": lead.name, "source": lead.source,
            "intent": lead.intent, "score": lead.score, "status": lead.status,
            "requested_service": lead.requested_service, "message": lead.message,
            "created_at": lead.created_at.isoformat(),
        }
        for lead in rows
    ]
