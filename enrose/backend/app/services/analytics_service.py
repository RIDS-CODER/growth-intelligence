"""Analytics ingest, cohort rollups, and the AI performance analysis.

The rollup is deterministic Python; the *interpretation* is the model's job. That
split is what stops the analyst hallucinating numbers: it is handed real aggregates
and asked only to explain them.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agents import LearningAgent, PerformanceAnalyst
from app.agents.base import AgentContext
from app.enums import ActorType, ContentStatus
from app.integrations.instagram import InstagramClient, get_instagram_client
from app.llm.provider import LLMProvider
from app.models.analytics import AIInsight, AnalyticsSnapshot
from app.models.brand import BrandMemory
from app.models.content import ContentItem
from app.models.publishing import PublishedPost, SocialAccount
from app.services import brand_service, content_status, memory, strategy_service

# Below this many posts in a cohort, differences are noise. The analyst is told so.
MIN_COHORT_SIZE = 3


@dataclass
class Cohort:
    key: str
    n: int
    avg_reach: float = 0.0
    avg_engagement_rate: float = 0.0
    avg_saves: float = 0.0
    avg_profile_visits: float = 0.0
    avg_shares: float = 0.0
    items: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "n": self.n,
            "avg_reach": round(self.avg_reach, 1),
            "avg_engagement_rate": round(self.avg_engagement_rate, 4),
            "avg_saves": round(self.avg_saves, 1),
            "avg_profile_visits": round(self.avg_profile_visits, 1),
            "avg_shares": round(self.avg_shares, 1),
            "sufficient_data": self.n >= MIN_COHORT_SIZE,
        }


def ingest_metrics(
    db: Session, client_id: uuid.UUID, *, client: InstagramClient | None = None, days: int = 90
) -> int:
    """Pull fresh metrics for recently published posts and append snapshots."""
    client = client or get_instagram_client()
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    account = db.execute(
        select(SocialAccount).where(SocialAccount.client_id == client_id)
    ).scalars().first()
    token = account.access_token if account and account.access_token else "mock_token"

    posts = db.execute(
        select(PublishedPost).where(
            PublishedPost.client_id == client_id, PublishedPost.published_at >= cutoff
        )
    ).scalars().all()

    written = 0
    for post in posts:
        try:
            result = client.fetch_metrics(post.platform_post_id, access_token=token)
        except Exception:  # noqa: BLE001 - one bad post must not abort the batch
            continue
        m = result.metrics
        reach = m.get("reach", 0.0)
        interactions = m.get("likes", 0) + m.get("comments", 0) + m.get("shares", 0) + m.get("saved", 0)
        db.add(
            AnalyticsSnapshot(
                client_id=client_id,
                content_item_id=post.content_item_id,
                published_post_id=post.id,
                captured_at=result.captured_at,
                reach=int(reach),
                impressions=int(m.get("impressions", 0)),
                views=int(m.get("views", 0)),
                likes=int(m.get("likes", 0)),
                comments=int(m.get("comments", 0)),
                shares=int(m.get("shares", 0)),
                saves=int(m.get("saved", 0)),
                follows=int(m.get("follows", 0)),
                profile_visits=int(m.get("profile_visits", 0)),
                link_clicks=int(m.get("link_clicks", 0)),
                engagement_rate=round(interactions / reach, 4) if reach else 0.0,
                provider=result.provider,
                raw=m,
            )
        )
        written += 1

        item = db.get(ContentItem, post.content_item_id)
        if item is not None and ContentStatus(item.status) is ContentStatus.PUBLISHED:
            content_status.transition(db, item, ContentStatus.ANALYZING, actor_type=ActorType.SYSTEM)

    db.commit()
    return written


def _latest_snapshots(db: Session, client_id: uuid.UUID, days: int) -> dict[uuid.UUID, AnalyticsSnapshot]:
    """Most recent snapshot per content item within the window."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    rows = db.execute(
        select(AnalyticsSnapshot)
        .where(AnalyticsSnapshot.client_id == client_id, AnalyticsSnapshot.captured_at >= cutoff)
        .order_by(AnalyticsSnapshot.captured_at.asc())
    ).scalars().all()
    latest: dict[uuid.UUID, AnalyticsSnapshot] = {}
    for row in rows:
        latest[row.content_item_id] = row  # ascending order means the last write wins
    return latest


def build_cohorts(db: Session, client_id: uuid.UUID, days: int = 30) -> dict[str, Any]:
    """Aggregate performance by pillar and by format."""
    latest = _latest_snapshots(db, client_id, days)
    if not latest:
        return {"by_pillar": [], "by_format": [], "totals": {}, "n_posts": 0, "period_days": days}

    items = {
        i.id: i
        for i in db.execute(
            select(ContentItem).where(ContentItem.id.in_(list(latest.keys())))
        ).scalars().all()
    }

    def group(attr: str) -> list[dict[str, Any]]:
        buckets: dict[str, list[AnalyticsSnapshot]] = {}
        for item_id, snap in latest.items():
            item = items.get(item_id)
            if item is None:
                continue
            buckets.setdefault(getattr(item, attr), []).append(snap)

        out: list[Cohort] = []
        for key, snaps in buckets.items():
            n = len(snaps)
            out.append(
                Cohort(
                    key=key,
                    n=n,
                    avg_reach=sum(s.reach for s in snaps) / n,
                    avg_engagement_rate=sum(s.engagement_rate for s in snaps) / n,
                    avg_saves=sum(s.saves for s in snaps) / n,
                    avg_profile_visits=sum(s.profile_visits for s in snaps) / n,
                    avg_shares=sum(s.shares for s in snaps) / n,
                )
            )
        out.sort(key=lambda c: c.avg_reach, reverse=True)
        return [c.as_dict() for c in out]

    all_snaps = list(latest.values())
    n = len(all_snaps)
    totals = {
        "posts": n,
        "total_reach": sum(s.reach for s in all_snaps),
        "total_saves": sum(s.saves for s in all_snaps),
        "total_profile_visits": sum(s.profile_visits for s in all_snaps),
        "avg_reach": round(sum(s.reach for s in all_snaps) / n, 1),
        "avg_engagement_rate": round(sum(s.engagement_rate for s in all_snaps) / n, 4),
    }

    ranked = sorted(latest.items(), key=lambda kv: kv[1].reach, reverse=True)

    def describe(pairs) -> list[dict[str, Any]]:
        out = []
        for item_id, snap in pairs:
            item = items.get(item_id)
            if item is None:
                continue
            out.append(
                {
                    "content_item_id": str(item_id),
                    "title": item.title,
                    "pillar": item.pillar,
                    "format": item.format,
                    "reach": snap.reach,
                    "saves": snap.saves,
                    "profile_visits": snap.profile_visits,
                    "engagement_rate": snap.engagement_rate,
                }
            )
        return out

    return {
        "by_pillar": group("pillar"),
        "by_format": group("format"),
        "totals": totals,
        "top_posts": describe(ranked[:5]),
        "bottom_posts": describe(ranked[-3:]) if len(ranked) > 5 else [],
        "n_posts": n,
        "period_days": days,
    }


def analyze_performance(
    db: Session, client_id: uuid.UUID, *, days: int = 30, provider: LLMProvider | None = None
) -> tuple[dict[str, Any], float]:
    """Run the performance analyst over real aggregates."""
    cohorts = build_cohorts(db, client_id, days)

    ctx = AgentContext(
        client_id=client_id,
        db=db,
        brand_block=brand_service.build_brand_block(db, client_id),
        memory_block=brand_service.build_memory_block(db, client_id),
        extra={
            "period_days": days,
            "cohorts": {"by_pillar": cohorts["by_pillar"], "by_format": cohorts["by_format"]},
            "top_posts": cohorts.get("top_posts", []),
            "bottom_posts": cohorts.get("bottom_posts", []),
            "totals": cohorts.get("totals", {}),
        },
    )
    result = PerformanceAnalyst(provider=provider).run(ctx)
    analysis = result.output

    for finding in analysis.findings:
        db.add(
            AIInsight(
                client_id=client_id,
                title=finding.headline,
                body=f"{finding.comparison}\n\nWhy: " + "; ".join(finding.why),
                kind="performance",
                evidence=finding.evidence,
                confidence=finding.confidence,
                recommendation=analysis.headline_recommendation,
                period_days=days,
            )
        )

    db.commit()
    return {"analysis": analysis.model_dump(mode="json"), "data": cohorts}, result.cost_usd


def run_learning_cycle(
    db: Session, client_id: uuid.UUID, *, days: int = 30, provider: LLMProvider | None = None
) -> dict[str, Any]:
    """Analytics → analysis → durable memory → capped strategy change.

    This is the loop that makes cycle N+1 differ from cycle N.
    """
    analysis_payload, analysis_cost = analyze_performance(db, client_id, days=days, provider=provider)

    ctx = AgentContext(
        client_id=client_id,
        db=db,
        brand_block=brand_service.build_brand_block(db, client_id),
        memory_block=brand_service.build_memory_block(db, client_id),
        extra={
            "analysis": analysis_payload["analysis"],
            "existing_insights": brand_service.active_insights(db, client_id),
        },
    )
    result = LearningAgent(provider=provider).run(ctx)
    update = result.output

    now = datetime.now(timezone.utc)
    stored: list[str] = []
    for insight in update.insights:
        row = BrandMemory(
            client_id=client_id,
            insight=insight.insight,
            kind=insight.kind,
            evidence=insight.evidence,
            confidence=insight.confidence,
            expires_at=now + timedelta(days=insight.expires_in_days),
            is_active=True,
        )
        db.add(row)
        db.flush()
        stored.append(str(row.id))

    # Retire contradicted beliefs rather than letting them accumulate.
    if update.superseded_insights:
        for old in db.execute(
            select(BrandMemory).where(
                BrandMemory.client_id == client_id, BrandMemory.is_active.is_(True)
            )
        ).scalars().all():
            if any(text[:60].lower() in old.insight.lower() for text in update.superseded_insights):
                old.is_active = False

    db.commit()

    changes = strategy_service.apply_pillar_deltas(db, client_id, update.pillar_weight_deltas)

    # Label content memory with how each piece actually performed.
    latest = _latest_snapshots(db, client_id, days)
    if latest:
        avg = sum(s.reach for s in latest.values()) / len(latest) or 1.0
        memory.update_outcomes(
            db, client_id, {item_id: (snap.reach / avg) for item_id, snap in latest.items()}
        )

    # Close the loop: analysed content becomes learned content.
    for item_id in latest:
        item = db.get(ContentItem, item_id)
        if item is not None and ContentStatus(item.status) is ContentStatus.ANALYZING:
            content_status.transition(db, item, ContentStatus.LEARNED, actor_type=ActorType.AGENT,
                                      actor_label="learning_agent")
    db.commit()

    return {
        "analysis": analysis_payload["analysis"],
        "data": analysis_payload["data"],
        "insights_stored": stored,
        "pillar_changes": changes,
        "learning_summary": update.summary,
        "cost_usd": round(analysis_cost + result.cost_usd, 6),
        "provider": result.provider,
    }


def summary(db: Session, client_id: uuid.UUID, days: int = 30) -> dict[str, Any]:
    """Dashboard/analytics payload."""
    cohorts = build_cohorts(db, client_id, days)
    insights = db.execute(
        select(AIInsight)
        .where(AIInsight.client_id == client_id, AIInsight.is_active.is_(True))
        .order_by(AIInsight.created_at.desc())
        .limit(5)
    ).scalars().all()
    cohorts["insights"] = [
        {
            "id": str(i.id),
            "title": i.title,
            "body": i.body,
            "confidence": i.confidence,
            "recommendation": i.recommendation,
            "created_at": i.created_at.isoformat(),
        }
        for i in insights
    ]
    return cohorts
