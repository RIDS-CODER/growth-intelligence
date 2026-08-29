"""Brand Brain routes."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.brand import Competitor, ContentPillar, Service
from app.schemas.api import BrandUpdate, CompetitorIn, PillarIn, ServiceIn
from app.security import TenantContext, get_tenant
from app.services import brand_service

router = APIRouter(prefix="/brands", tags=["brand"])


@router.get("")
def get_brand_brain(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> dict:
    """The whole Brand Brain, plus the gaps limiting content quality."""
    brand = brand_service.build_brand_dict(db, tenant.client_id)
    if not brand:
        raise HTTPException(status_code=404, detail="No brand configured for this client")
    completeness, missing = brand_service.compute_completeness(db, tenant.client_id)
    db.commit()
    brand["completeness"] = completeness
    brand["missing_fields"] = missing
    brand["competitors"] = brand_service.list_competitors(db, tenant.client_id)
    return brand


@router.patch("")
def update_brand(
    payload: BrandUpdate,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    brand = brand_service.get_brand(db, tenant.client_id)
    if brand is None:
        raise HTTPException(status_code=404, detail="No brand configured for this client")

    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(brand, field, value)

    # A field the client has now filled is no longer unknown.
    supplied = set(payload.model_dump(exclude_unset=True).keys())
    brand.unknown_fields = [f for f in (brand.unknown_fields or []) if f not in supplied]

    db.commit()
    brand_service.compute_completeness(db, tenant.client_id)
    db.commit()
    return brand_service.build_brand_dict(db, tenant.client_id)


@router.post("/services", status_code=201)
def add_service(
    payload: ServiceIn,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    brand = brand_service.get_brand(db, tenant.client_id)
    if brand is None:
        raise HTTPException(status_code=404, detail="No brand configured")
    service = Service(client_id=tenant.client_id, brand_id=brand.id, **payload.model_dump())
    db.add(service)
    db.commit()
    db.refresh(service)
    return {"id": str(service.id), **payload.model_dump()}


@router.delete("/services/{service_id}", status_code=204)
def delete_service(
    service_id: uuid.UUID,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> None:
    service = db.execute(
        select(Service).where(Service.id == service_id, Service.client_id == tenant.client_id)
    ).scalar_one_or_none()
    if service is None:
        raise HTTPException(status_code=404, detail="Service not found")
    db.delete(service)
    db.commit()


@router.get("/pillars")
def list_pillars(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> list[dict]:
    rows = db.execute(
        select(ContentPillar)
        .where(ContentPillar.client_id == tenant.client_id)
        .order_by(ContentPillar.weight.desc())
    ).scalars().all()
    return [
        {
            "id": str(p.id), "key": p.key, "label": p.label, "description": p.description,
            "objective": p.objective, "weight": p.weight, "examples": p.examples,
            "source": p.source, "is_active": p.is_active,
        }
        for p in rows
    ]


@router.put("/pillars/{pillar_id}")
def update_pillar(
    pillar_id: uuid.UUID,
    payload: PillarIn,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    pillar = db.execute(
        select(ContentPillar).where(
            ContentPillar.id == pillar_id, ContentPillar.client_id == tenant.client_id
        )
    ).scalar_one_or_none()
    if pillar is None:
        raise HTTPException(status_code=404, detail="Pillar not found")
    for field, value in payload.model_dump().items():
        setattr(pillar, field, value)
    pillar.source = "client"
    db.commit()
    return {"id": str(pillar.id), **payload.model_dump(), "source": pillar.source}


@router.get("/competitors")
def list_competitors(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> list[dict]:
    return brand_service.list_competitors(db, tenant.client_id)


@router.post("/competitors", status_code=201)
def add_competitor(
    payload: CompetitorIn,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    competitor = Competitor(client_id=tenant.client_id, **payload.model_dump())
    db.add(competitor)
    db.commit()
    db.refresh(competitor)
    return {"id": str(competitor.id), **payload.model_dump()}
