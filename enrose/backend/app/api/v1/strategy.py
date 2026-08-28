"""Strategy, calendar, trends and competitor routes."""

from __future__ import annotations

import uuid
from datetime import datetime, time, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.content import CalendarEntry, Strategy
from app.models.research import Trend
from app.schemas.api import (
    AttachContentRequest,
    CalendarEntryOut,
    CalendarGenerateRequest,
    RescheduleRequest,
    StrategyGenerateRequest,
    StrategyOut,
)
from app.security import TenantContext, get_tenant
from app.services import calendar_service, strategy_service

router = APIRouter(tags=["strategy"])


@router.get("/strategy", response_model=list[StrategyOut])
def list_strategies(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> list[Strategy]:
    return list(
        db.execute(
            select(Strategy)
            .where(Strategy.client_id == tenant.client_id)
            .order_by(Strategy.created_at.desc())
            .limit(20)
        ).scalars().all()
    )


@router.get("/strategy/active", response_model=StrategyOut | None)
def active_strategy(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> Strategy | None:
    return db.execute(
        select(Strategy)
        .where(Strategy.client_id == tenant.client_id, Strategy.status == "active")
        .order_by(Strategy.created_at.desc())
    ).scalars().first()


@router.post("/strategy/generate")
def generate_strategy(
    payload: StrategyGenerateRequest,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    """Plan the next cycle. Optionally refresh the brand strategy first."""
    cost = 0.0
    if payload.refresh_brand:
        _, brand_cost = strategy_service.generate_brand_strategy(db, tenant.client_id)
        cost += brand_cost

    strategy, strategy_cost = strategy_service.generate_content_strategy(
        db,
        tenant.client_id,
        period_start=payload.period_start,
        period_days=payload.period_days,
        emphasis=payload.emphasis,
    )
    cost += strategy_cost
    return {
        "strategy": StrategyOut.model_validate(strategy).model_dump(mode="json"),
        "cost_usd": round(cost, 6),
    }


@router.post("/strategy/brand")
def generate_brand_strategy(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> dict:
    try:
        brand, cost = strategy_service.generate_brand_strategy(db, tenant.client_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "positioning": brand.positioning,
        "tone": brand.tone,
        "unknown_fields": brand.unknown_fields,
        "completeness": brand.completeness,
        "cost_usd": cost,
    }


# ── Calendar ────────────────────────────────────────────────────────────────


@router.get("/calendar", response_model=list[CalendarEntryOut])
def list_calendar(
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> list[CalendarEntry]:
    query = select(CalendarEntry).where(CalendarEntry.client_id == tenant.client_id)
    if start:
        query = query.where(CalendarEntry.scheduled_for >= start)
    if end:
        query = query.where(CalendarEntry.scheduled_for <= end)
    return list(db.execute(query.order_by(CalendarEntry.scheduled_for)).scalars().all())


@router.post("/calendar/generate")
def generate_calendar(
    payload: CalendarGenerateRequest,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    plan = calendar_service.generate_calendar(
        db,
        tenant.client_id,
        start=payload.start,
        days=payload.days,
        replace_existing=payload.replace_existing,
    )
    return {
        "entries": [
            CalendarEntryOut.model_validate(e).model_dump(mode="json") for e in plan.entries
        ],
        "counts": plan.counts,
        "strategy_id": str(plan.strategy_id) if plan.strategy_id else None,
    }


@router.patch("/calendar/{entry_id}", response_model=CalendarEntryOut)
def reschedule(
    entry_id: uuid.UUID,
    payload: RescheduleRequest,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> CalendarEntry:
    try:
        return calendar_service.reschedule(db, tenant.client_id, entry_id, payload.scheduled_for)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/calendar/{entry_id}/attach", response_model=CalendarEntryOut)
def attach_content(
    entry_id: uuid.UUID,
    payload: AttachContentRequest,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> CalendarEntry:
    try:
        return calendar_service.attach_content(
            db, tenant.client_id, entry_id, payload.content_item_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# ── Trends & competitors ────────────────────────────────────────────────────


@router.get("/trends")
def list_trends(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> list[dict]:
    rows = db.execute(
        select(Trend)
        .where(Trend.client_id == tenant.client_id)
        .order_by(Trend.relevance_score.desc())
        .limit(50)
    ).scalars().all()
    return [
        {
            "id": str(t.id), "name": t.name, "category": t.category, "description": t.description,
            "popularity": t.popularity, "relevance_score": t.relevance_score,
            "expiry_probability": t.expiry_probability, "fits_brand": t.fits_brand,
            "fit_reason": t.fit_reason, "recommended_adaptation": t.recommended_adaptation,
            "status": t.status, "detected_on": t.detected_on.isoformat(),
        }
        for t in rows
    ]


@router.post("/trends/research")
def research_trends(
    focus: str | None = None,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    trends, cost = strategy_service.research_trends(db, tenant.client_id, focus=focus)
    return {
        "detected": len(trends),
        "adopted": sum(1 for t in trends if t.fits_brand),
        "rejected": sum(1 for t in trends if not t.fits_brand),
        "cost_usd": cost,
    }


@router.post("/competitors/analyze")
def analyze_competitors(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> dict:
    report, cost = strategy_service.analyze_competitors(db, tenant.client_id)
    return {"report": report, "cost_usd": cost}
