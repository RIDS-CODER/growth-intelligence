"""Content generation, editing, approval and scheduling routes."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.enums import ContentStatus
from app.models.content import ContentIdea, ContentItem, ContentVariant
from app.schemas.api import (
    ApprovalRequest,
    AttachAssetsRequest,
    ContentGenerateRequest,
    ContentItemDetail,
    ContentItemSummary,
    ContentUpdate,
    GenerationResponse,
    ScheduleRequest,
)
from app.security import TenantContext, get_tenant
from app.services import approval_service, calendar_service, content_service, footage_service
from app.services.content_status import InvalidTransition

router = APIRouter(prefix="/content", tags=["content"])


def _get_item(db: Session, client_id: uuid.UUID, item_id: uuid.UUID) -> ContentItem:
    item = db.execute(
        select(ContentItem).where(ContentItem.id == item_id, ContentItem.client_id == client_id)
    ).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="Content item not found")
    return item


@router.get("", response_model=list[ContentItemSummary])
def list_content(
    status: str | None = Query(default=None),
    pillar: str | None = Query(default=None),
    content_format: str | None = Query(default=None, alias="format"),
    limit: int = Query(default=100, ge=1, le=500),
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> list[ContentItem]:
    query = select(ContentItem).where(ContentItem.client_id == tenant.client_id)
    if status:
        query = query.where(ContentItem.status == status)
    if pillar:
        query = query.where(ContentItem.pillar == pillar)
    if content_format:
        query = query.where(ContentItem.format == content_format)
    query = query.order_by(ContentItem.created_at.desc()).limit(limit)
    return list(db.execute(query).scalars().all())


@router.get("/queue", response_model=list[ContentItemSummary])
def approval_queue(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> list[ContentItem]:
    return approval_service.approval_queue(db, tenant.client_id)


@router.get("/ideas")
def list_ideas(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> list[dict]:
    rows = db.execute(
        select(ContentIdea)
        .where(ContentIdea.client_id == tenant.client_id, ContentIdea.status == "open")
        .order_by(ContentIdea.created_at.desc())
        .limit(100)
    ).scalars().all()
    return [
        {
            "id": str(i.id), "title": i.title, "pillar": i.pillar, "format": i.format,
            "objective": i.objective, "hook": i.hook, "summary": i.summary, "status": i.status,
        }
        for i in rows
    ]


@router.post("/generate", response_model=GenerationResponse)
def generate(
    payload: ContentGenerateRequest,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> GenerationResponse:
    """Generate content through the full pipeline.

    A rejection is reported per item rather than failing the batch: with `count > 1`
    it is normal and correct for some drafts to be auto-rejected by QA, and the
    client should still receive the ones that passed.
    """
    created: list[ContentItem] = []
    rejected: list[dict] = []
    total_cost = 0.0
    provider = "unknown"

    for _ in range(payload.count):
        try:
            result = content_service.generate_content(
                db,
                tenant.client_id,
                content_format=payload.format,
                pillar=payload.pillar,
                topic=payload.topic,
                objective=payload.objective,
                brief=payload.brief,
                idea_id=payload.idea_id,
                # With count > 1 the same topic would collide with itself; let the
                # writer choose distinct angles after the first.
                skip_duplicate_check=False,
            )
            created.append(result.item)
            total_cost += result.cost_usd
            provider = result.provider

            if payload.calendar_entry_id and len(created) == 1:
                calendar_service.attach_content(
                    db, tenant.client_id, payload.calendar_entry_id, result.item.id
                )
        except content_service.GenerationRejected as exc:
            rejected.append({"stage": exc.stage, "reason": exc.reason, "detail": exc.detail})

    if not created and rejected:
        raise HTTPException(
            status_code=422,
            detail={"message": "No content passed quality control.", "rejected": rejected},
        )

    return GenerationResponse(
        items=[ContentItemSummary.model_validate(i) for i in created],
        rejected=rejected,
        cost_usd=round(total_cost, 6),
        provider=provider,
    )


@router.get("/{item_id}", response_model=ContentItemDetail)
def get_content(
    item_id: uuid.UUID,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> ContentItem:
    return _get_item(db, tenant.client_id, item_id)


@router.patch("/{item_id}", response_model=ContentItemDetail)
def update_content(
    item_id: uuid.UUID,
    payload: ContentUpdate,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> ContentItem:
    """Client edits. Re-scanned for safety — a human edit can introduce a price too."""
    from app.services import brand_service, safety

    item = _get_item(db, tenant.client_id, item_id)
    updates = payload.model_dump(exclude_unset=True)

    brand = brand_service.build_brand_dict(db, tenant.client_id)
    scan = safety.scan_content_item(
        {k: v for k, v in updates.items() if isinstance(v, (str, list))},
        known_services=brand_service.known_service_names(brand),
        known_products=brand_service.known_product_names(brand),
    )
    if not scan.passed:
        raise HTTPException(
            status_code=422,
            detail={"message": "Edit rejected by the safety scanner.", "findings": scan.to_dict()},
        )

    for field, value in updates.items():
        setattr(item, field, value)
    db.commit()
    db.refresh(item)
    return item


@router.get("/{item_id}/variants")
def list_variants(
    item_id: uuid.UUID,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> list[dict]:
    _get_item(db, tenant.client_id, item_id)
    rows = db.execute(
        select(ContentVariant).where(ContentVariant.content_item_id == item_id)
    ).scalars().all()
    return [
        {"id": str(v.id), "kind": v.kind, "label": v.label, "body": v.body,
         "is_selected": v.is_selected, "meta": v.meta}
        for v in rows
    ]


@router.post("/{item_id}/captions")
def generate_captions(
    item_id: uuid.UUID,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    item = _get_item(db, tenant.client_id, item_id)
    try:
        variants, cost = content_service.generate_captions(db, tenant.client_id, item)
    except content_service.GenerationRejected as exc:
        raise HTTPException(status_code=422, detail={"reason": exc.reason, "detail": exc.detail}) from exc
    return {
        "variants": [
            {"id": str(v.id), "label": v.label, "body": v.body, "is_selected": v.is_selected,
             "meta": v.meta}
            for v in variants
        ],
        "cost_usd": cost,
    }


@router.post("/{item_id}/assets")
def attach_assets(
    item_id: uuid.UUID,
    payload: AttachAssetsRequest,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    try:
        links = footage_service.attach_assets(
            db, tenant.client_id, item_id, payload.asset_ids, role=payload.role
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "attached": [
            {"asset_id": str(link.asset_id), "role": link.role, "position": link.position}
            for link in links
        ]
    }


@router.post("/{item_id}/approve", response_model=ContentItemDetail)
def approve(
    item_id: uuid.UUID,
    payload: ApprovalRequest | None = None,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> ContentItem:
    item = _get_item(db, tenant.client_id, item_id)
    try:
        return approval_service.approve(
            db, item, actor_id=tenant.user_id, note=payload.note if payload else None
        )
    except InvalidTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{item_id}/reject", response_model=ContentItemDetail)
def reject(
    item_id: uuid.UUID,
    payload: ApprovalRequest | None = None,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> ContentItem:
    item = _get_item(db, tenant.client_id, item_id)
    try:
        return approval_service.reject(
            db, item, actor_id=tenant.user_id, note=payload.note if payload else None
        )
    except InvalidTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{item_id}/request-revision", response_model=ContentItemDetail)
def request_revision(
    item_id: uuid.UUID,
    payload: ApprovalRequest | None = None,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> ContentItem:
    item = _get_item(db, tenant.client_id, item_id)
    try:
        return approval_service.request_revision(
            db, item, actor_id=tenant.user_id, note=payload.note if payload else None
        )
    except InvalidTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{item_id}/schedule")
def schedule(
    item_id: uuid.UUID,
    payload: ScheduleRequest,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    item = _get_item(db, tenant.client_id, item_id)
    try:
        post = approval_service.schedule(db, item, payload.publish_at, actor_id=tenant.user_id)
    except InvalidTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {
        "scheduled_post_id": str(post.id),
        "publish_at": post.publish_at.isoformat(),
        "status": post.status,
        "provider": post.provider,
        "is_mock": post.provider == "mock",
    }


@router.get("/{item_id}/eligibility")
def auto_publish_eligibility(
    item_id: uuid.UUID,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    """Why this item can or cannot be published without a human."""
    item = _get_item(db, tenant.client_id, item_id)
    result = approval_service.auto_publish_eligibility(item, client_enabled=False)
    return {"eligible": result.eligible, "reasons": result.reasons}


@router.get("/status/pipeline")
def pipeline_counts(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> dict[str, int]:
    rows = db.execute(
        select(ContentItem.status).where(ContentItem.client_id == tenant.client_id)
    ).scalars().all()
    counts = {status.value: 0 for status in ContentStatus}
    for status in rows:
        counts[status] = counts.get(status, 0) + 1
    return counts
