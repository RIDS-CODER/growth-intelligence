"""Brand Brain assembly.

Produces the dict that `prompts.shared.render_brand_block` turns into the prompt
context, and computes the completeness score the UI uses to nudge the client into
filling the gaps that limit content quality.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.brand import (
    Audience,
    Brand,
    BrandMemory,
    Competitor,
    ContentPillar,
    Product,
    Service,
)
from app.prompts.shared import render_brand_block, render_memory_block
from app.services import memory as memory_service

# Fields whose absence measurably narrows what the content engine can safely say.
# Weighted, because a missing booking link costs more than a missing font.
COMPLETENESS_FIELDS: dict[str, float] = {
    "description": 1.0,
    "positioning": 1.5,
    "tone": 1.5,
    "visual_identity": 1.0,
    "locations": 1.0,
    "services": 2.0,
    "products": 1.0,
    "audiences": 1.5,
    "business_goals": 1.0,
    "pillars": 1.5,
    "pricing": 1.5,
    "booking_link": 1.0,
    "brand_colors": 0.5,
    "brand_fonts": 0.5,
    "logo": 0.5,
}


def get_brand(db: Session, client_id: uuid.UUID) -> Brand | None:
    return db.execute(
        select(Brand).where(Brand.client_id == client_id)
    ).scalars().first()


def build_brand_dict(db: Session, client_id: uuid.UUID) -> dict[str, Any]:
    """Assemble the full Brand Brain as a plain dict."""
    brand = get_brand(db, client_id)
    if brand is None:
        return {}

    services = db.execute(
        select(Service).where(Service.brand_id == brand.id, Service.is_active.is_(True))
    ).scalars().all()
    products = db.execute(select(Product).where(Product.brand_id == brand.id)).scalars().all()
    audiences = db.execute(
        select(Audience).where(Audience.brand_id == brand.id).order_by(Audience.priority)
    ).scalars().all()
    pillars = db.execute(
        select(ContentPillar)
        .where(ContentPillar.client_id == client_id, ContentPillar.is_active.is_(True))
        .order_by(ContentPillar.weight.desc())
    ).scalars().all()

    return {
        "id": str(brand.id),
        "name": brand.name,
        "website": brand.website,
        "instagram_handle": brand.instagram_handle,
        "description": brand.description,
        "positioning": brand.positioning,
        "tone": brand.tone or {},
        "visual_identity": brand.visual_identity or {},
        "locations": brand.locations or [],
        "business_goals": brand.business_goals or [],
        "words_to_avoid": brand.words_to_avoid or [],
        "claims_to_avoid": brand.claims_to_avoid or [],
        "unknown_fields": brand.unknown_fields or [],
        "provenance": brand.provenance or {},
        "completeness": brand.completeness,
        "services": [
            {
                "id": str(s.id),
                "name": s.name,
                "category": s.category,
                "description": s.description,
                "price": s.price,
                "currency": s.currency,
                "confidence": s.confidence,
            }
            for s in services
        ],
        "products": [
            {"id": str(p.id), "brand_name": p.brand_name, "category": p.category, "confidence": p.confidence}
            for p in products
        ],
        "audiences": [
            {
                "id": str(a.id),
                "segment": a.segment,
                "demographics": a.demographics or {},
                "pains": a.pains or [],
                "desires": a.desires or [],
                "priority": a.priority,
                "confidence": a.confidence,
            }
            for a in audiences
        ],
        "pillars": [
            {
                "id": str(p.id),
                "key": p.key,
                "label": p.label,
                "description": p.description,
                "objective": p.objective,
                "weight": p.weight,
                "examples": p.examples or [],
                "source": p.source,
            }
            for p in pillars
        ],
    }


def known_service_names(brand: dict[str, Any]) -> list[str]:
    return [s["name"] for s in brand.get("services", [])]


def known_product_names(brand: dict[str, Any]) -> list[str]:
    return [p["brand_name"] for p in brand.get("products", [])]


def build_brand_block(db: Session, client_id: uuid.UUID) -> str:
    return render_brand_block(build_brand_dict(db, client_id))


def active_insights(db: Session, client_id: uuid.UUID, limit: int = 15) -> list[dict[str, Any]]:
    from datetime import datetime, timezone

    rows = db.execute(
        select(BrandMemory)
        .where(BrandMemory.client_id == client_id, BrandMemory.is_active.is_(True))
        .order_by(BrandMemory.confidence.desc())
        .limit(limit)
    ).scalars().all()
    now = datetime.now(timezone.utc)
    out = []
    for row in rows:
        # Expired beliefs are worse than none — drop them rather than teaching from them.
        if row.expires_at is not None:
            expires = row.expires_at
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            if expires < now:
                continue
        out.append(
            {
                "id": str(row.id),
                "insight": row.insight,
                "kind": row.kind,
                "evidence": row.evidence or {},
                "confidence": row.confidence,
            }
        )
    return out


def build_memory_block(db: Session, client_id: uuid.UUID) -> str:
    return render_memory_block(
        active_insights(db, client_id), memory_service.recent_topics(db, client_id)
    )


def compute_completeness(db: Session, client_id: uuid.UUID) -> tuple[float, list[str]]:
    """Score how complete the Brand Brain is, and name what is missing.

    Returned as (percentage, missing field names). The UI shows both, because a
    number alone does not tell the client what to do about it.
    """
    brand = get_brand(db, client_id)
    if brand is None:
        return 0.0, list(COMPLETENESS_FIELDS)

    data = build_brand_dict(db, client_id)
    present: dict[str, bool] = {
        "description": bool(data.get("description")),
        "positioning": bool(data.get("positioning")),
        "tone": bool(data.get("tone")),
        "visual_identity": bool(data.get("visual_identity")),
        "locations": bool(data.get("locations")),
        "services": bool(data.get("services")),
        "products": bool(data.get("products")),
        "audiences": bool(data.get("audiences")),
        "business_goals": bool(data.get("business_goals")),
        "pillars": bool(data.get("pillars")),
        "pricing": any(s.get("price") is not None for s in data.get("services", [])),
        "booking_link": bool((data.get("visual_identity") or {}).get("booking_link"))
        or "booking_link" not in (data.get("unknown_fields") or []),
        "brand_colors": bool((data.get("visual_identity") or {}).get("colors")),
        "brand_fonts": bool((data.get("visual_identity") or {}).get("fonts")),
        "logo": bool((data.get("visual_identity") or {}).get("logo_key")),
    }

    earned = sum(weight for field, weight in COMPLETENESS_FIELDS.items() if present.get(field))
    total = sum(COMPLETENESS_FIELDS.values())
    pct = round(100 * earned / total, 1)
    missing = [field for field in COMPLETENESS_FIELDS if not present.get(field)]

    brand.completeness = pct
    db.flush()
    return pct, missing


def list_competitors(db: Session, client_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = db.execute(
        select(Competitor).where(Competitor.client_id == client_id, Competitor.is_active.is_(True))
    ).scalars().all()
    return [
        {
            "id": str(c.id),
            "name": c.name,
            "handle": c.handle,
            "website": c.website,
            "tier": c.tier,
            "notes": c.notes,
            "last_analyzed_at": c.last_analyzed_at.isoformat() if c.last_analyzed_at else None,
        }
        for c in rows
    ]
