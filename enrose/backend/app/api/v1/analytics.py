"""Analytics, insights, publishing control and the AI activity log."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.analytics import AIInsight, AnalyticsSnapshot
from app.models.ops import AIActivityLog
from app.models.publishing import PublishedPost, ScheduledPost, SocialAccount
from app.schemas.api import AnalyzeRequest, MetricIngestItem
from app.security import TenantContext, get_tenant
from app.services import analytics_service, publishing_service

router = APIRouter(tags=["analytics"])


@router.get("/analytics/summary")
def summary(
    days: int = Query(default=30, ge=1, le=365),
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    return analytics_service.summary(db, tenant.client_id, days)


@router.post("/analytics/ingest")
def ingest(
    days: int = Query(default=90, ge=1, le=365),
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    """Pull metrics from the connected account (or the labelled mock)."""
    from app.integrations.instagram import get_instagram_client

    client = get_instagram_client()
    written = analytics_service.ingest_metrics(db, tenant.client_id, client=client, days=days)
    return {"snapshots_written": written, "provider": client.name, "is_mock": client.name == "mock"}


@router.post("/analytics/manual")
def manual_ingest(
    items: list[MetricIngestItem],
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    """Enter metrics by hand, for accounts not yet connected to the Graph API."""
    written = 0
    for entry in items:
        interactions = entry.likes + entry.comments + entry.shares + entry.saves
        db.add(
            AnalyticsSnapshot(
                client_id=tenant.client_id,
                content_item_id=entry.content_item_id,
                captured_at=entry.captured_at or datetime.now(timezone.utc),
                reach=entry.reach,
                impressions=entry.impressions,
                views=entry.views,
                likes=entry.likes,
                comments=entry.comments,
                shares=entry.shares,
                saves=entry.saves,
                follows=entry.follows,
                profile_visits=entry.profile_visits,
                link_clicks=entry.link_clicks,
                engagement_rate=round(interactions / entry.reach, 4) if entry.reach else 0.0,
                provider="manual",
                raw={"source": "manual_entry"},
            )
        )
        written += 1
    db.commit()
    return {"snapshots_written": written, "provider": "manual"}


@router.post("/analytics/analyze")
def analyze(
    payload: AnalyzeRequest,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    """Ask the AI why content performed the way it did."""
    result, cost = analytics_service.analyze_performance(db, tenant.client_id, days=payload.days)
    return {**result, "cost_usd": cost}


@router.post("/analytics/learn")
def learn(
    payload: AnalyzeRequest,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    """Run the full learning cycle: analyse, store insights, adjust strategy."""
    return analytics_service.run_learning_cycle(db, tenant.client_id, days=payload.days)


@router.get("/insights")
def list_insights(
    limit: int = Query(default=20, ge=1, le=100),
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> list[dict]:
    rows = db.execute(
        select(AIInsight)
        .where(AIInsight.client_id == tenant.client_id, AIInsight.is_active.is_(True))
        .order_by(AIInsight.created_at.desc())
        .limit(limit)
    ).scalars().all()
    return [
        {
            "id": str(i.id), "title": i.title, "body": i.body, "kind": i.kind,
            "evidence": i.evidence, "confidence": i.confidence,
            "recommendation": i.recommendation, "period_days": i.period_days,
            "created_at": i.created_at.isoformat(),
        }
        for i in rows
    ]


# ── Publishing ──────────────────────────────────────────────────────────────


@router.get("/publishing/queue")
def publishing_queue(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> list[dict]:
    rows = db.execute(
        select(ScheduledPost)
        .where(ScheduledPost.client_id == tenant.client_id)
        .order_by(ScheduledPost.publish_at)
        .limit(100)
    ).scalars().all()
    return [
        {
            "id": str(p.id), "content_item_id": str(p.content_item_id),
            "publish_at": p.publish_at.isoformat(), "status": p.status,
            "attempts": p.attempts, "last_error": p.last_error,
            "provider": p.provider, "is_mock": p.provider == "mock",
        }
        for p in rows
    ]


@router.post("/publishing/run")
def run_publisher(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> dict:
    """Publish everything currently due. Normally driven by the worker."""
    from app.integrations.instagram import get_instagram_client

    client = get_instagram_client()
    result = publishing_service.run_due(db, client=client)
    return {**result, "provider": client.name, "is_mock": client.name == "mock"}


@router.get("/publishing/published")
def published_posts(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> list[dict]:
    rows = db.execute(
        select(PublishedPost)
        .where(PublishedPost.client_id == tenant.client_id)
        .order_by(PublishedPost.published_at.desc())
        .limit(100)
    ).scalars().all()
    return [
        {
            "id": str(p.id), "content_item_id": str(p.content_item_id),
            "platform_post_id": p.platform_post_id, "permalink": p.permalink,
            "published_at": p.published_at.isoformat(), "provider": p.provider,
            "is_mock": p.provider == "mock",
        }
        for p in rows
    ]


@router.get("/social/accounts")
def social_accounts(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> list[dict]:
    rows = db.execute(
        select(SocialAccount).where(SocialAccount.client_id == tenant.client_id)
    ).scalars().all()
    # Access tokens are never returned by the API.
    return [
        {
            "id": str(a.id), "platform": a.platform, "handle": a.handle,
            "is_active": a.is_active, "is_mock": a.is_mock,
            "connected": bool(a.access_token), "scopes": a.scopes,
        }
        for a in rows
    ]


# ── AI activity log ─────────────────────────────────────────────────────────


@router.get("/ops/ai-activity")
def ai_activity(
    limit: int = Query(default=50, ge=1, le=200),
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    rows = db.execute(
        select(AIActivityLog)
        .where(AIActivityLog.client_id == tenant.client_id)
        .order_by(AIActivityLog.created_at.desc())
        .limit(limit)
    ).scalars().all()

    totals = db.execute(
        select(
            func.count(AIActivityLog.id),
            func.coalesce(func.sum(AIActivityLog.cost_usd), 0.0),
            func.coalesce(func.sum(AIActivityLog.input_tokens), 0),
            func.coalesce(func.sum(AIActivityLog.output_tokens), 0),
        ).where(AIActivityLog.client_id == tenant.client_id)
    ).one()

    by_agent = db.execute(
        select(
            AIActivityLog.agent,
            func.count(AIActivityLog.id),
            func.coalesce(func.sum(AIActivityLog.cost_usd), 0.0),
        )
        .where(AIActivityLog.client_id == tenant.client_id)
        .group_by(AIActivityLog.agent)
    ).all()

    return {
        "entries": [
            {
                "id": str(r.id), "agent": r.agent, "task": r.task, "model": r.model,
                "provider": r.provider, "input_tokens": r.input_tokens,
                "output_tokens": r.output_tokens, "cost_usd": r.cost_usd,
                "duration_ms": r.duration_ms, "success": r.success, "error": r.error,
                "retries": r.retries, "created_at": r.created_at.isoformat(),
            }
            for r in rows
        ],
        "totals": {
            "calls": totals[0], "cost_usd": round(float(totals[1]), 6),
            "input_tokens": int(totals[2]), "output_tokens": int(totals[3]),
        },
        "by_agent": [
            {"agent": a, "calls": c, "cost_usd": round(float(cost), 6)} for a, c, cost in by_agent
        ],
    }
