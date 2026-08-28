"""Asset upload, footage analysis and the capture checklist."""

from __future__ import annotations

import mimetypes
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.enums import AssetKind, FootageType
from app.integrations.storage import LocalStorage, get_storage, probe_media
from app.models.content import Asset
from app.schemas.api import AssetOut, FootageAnalyzeRequest
from app.security import TenantContext, get_tenant
from app.services import footage_service

router = APIRouter(prefix="/assets", tags=["assets"])

MAX_UPLOAD_BYTES = 500 * 1024 * 1024  # 500 MB — a long 4K salon clip fits comfortably


def _kind_for(mime: str | None, filename: str) -> AssetKind:
    mime = mime or mimetypes.guess_type(filename)[0] or ""
    if mime.startswith("video"):
        return AssetKind.VIDEO
    if mime.startswith("image"):
        return AssetKind.IMAGE
    if mime.startswith("audio"):
        return AssetKind.AUDIO
    return AssetKind.DOCUMENT


@router.get("", response_model=list[AssetOut])
def list_assets(
    footage_type: str | None = Query(default=None),
    shoot_group: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> list[Asset]:
    query = select(Asset).where(Asset.client_id == tenant.client_id)
    if footage_type:
        query = query.where(Asset.footage_type == footage_type)
    if shoot_group:
        query = query.where(Asset.shoot_group == shoot_group)
    return list(db.execute(query.order_by(Asset.created_at.desc()).limit(limit)).scalars().all())


@router.post("", response_model=AssetOut, status_code=201)
async def upload_asset(
    file: UploadFile = File(...),
    footage_type: str = Form(default=FootageType.UNTAGGED.value),
    shoot_group: str | None = Form(default=None),
    notes: str | None = Form(default=None),
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> Asset:
    """Upload raw salon footage or an image."""
    if footage_type not in {ft.value for ft in FootageType}:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown footage_type '{footage_type}'. Valid: {[ft.value for ft in FootageType]}",
        )

    filename = file.filename or "upload"
    storage = get_storage()
    key = storage.build_key(tenant.client_id, filename)

    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds the 500 MB upload limit.")

    import io

    stored = storage.put(io.BytesIO(contents), key=key, content_type=file.content_type)

    # Probe duration where FFmpeg is available; nulls otherwise, never a guess.
    probed: dict = {"duration_s": None, "width": None, "height": None}
    if isinstance(storage, LocalStorage):
        probed = probe_media(str((storage.root / key).resolve()))

    asset = Asset(
        client_id=tenant.client_id,
        filename=filename,
        kind=_kind_for(file.content_type, filename).value,
        storage_key=stored.key,
        mime_type=file.content_type,
        size_bytes=stored.size_bytes,
        duration_s=probed.get("duration_s"),
        width=probed.get("width"),
        height=probed.get("height"),
        footage_type=footage_type,
        notes=notes,
        shoot_group=shoot_group,
        provider=stored.provider,
    )
    db.add(asset)
    db.commit()
    db.refresh(asset)
    return asset


@router.get("/file/{key:path}")
def serve_file(
    key: str,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> FileResponse:
    """Serve a locally-stored asset.

    The key is checked against an asset row owned by this client, so one tenant
    cannot read another's media by guessing a path.
    """
    asset = db.execute(
        select(Asset).where(Asset.storage_key == key, Asset.client_id == tenant.client_id)
    ).scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")

    storage = get_storage()
    if not isinstance(storage, LocalStorage):
        raise HTTPException(
            status_code=400, detail="Assets are stored remotely; use the storage URL instead."
        )
    path = Path(storage.root) / key
    if not path.exists():
        raise HTTPException(status_code=404, detail="File missing from storage")
    return FileResponse(path, media_type=asset.mime_type or "application/octet-stream")


@router.patch("/{asset_id}", response_model=AssetOut)
def update_asset(
    asset_id: uuid.UUID,
    footage_type: str | None = None,
    notes: str | None = None,
    shoot_group: str | None = None,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> Asset:
    asset = db.execute(
        select(Asset).where(Asset.id == asset_id, Asset.client_id == tenant.client_id)
    ).scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    if footage_type is not None:
        if footage_type not in {ft.value for ft in FootageType}:
            raise HTTPException(status_code=422, detail=f"Unknown footage_type '{footage_type}'")
        asset.footage_type = footage_type
    if notes is not None:
        asset.notes = notes
    if shoot_group is not None:
        asset.shoot_group = shoot_group
    db.commit()
    db.refresh(asset)
    return asset


@router.delete("/{asset_id}", status_code=204)
def delete_asset(
    asset_id: uuid.UUID,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> None:
    asset = db.execute(
        select(Asset).where(Asset.id == asset_id, Asset.client_id == tenant.client_id)
    ).scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    try:
        get_storage().delete(asset.storage_key)
    except (OSError, ValueError):
        # The row must go even if the blob is already gone; a dangling row is worse.
        pass
    db.delete(asset)
    db.commit()


@router.post("/analyze")
def analyze_footage(
    payload: FootageAnalyzeRequest,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    """Decide which reel this footage supports, and what is missing."""
    try:
        analysis, cost = footage_service.analyze_footage(
            db,
            tenant.client_id,
            asset_ids=payload.asset_ids,
            shoot_group=payload.shoot_group,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"analysis": analysis, "cost_usd": cost}


@router.post("/capture-checklist")
def capture_checklist(
    week_of: str | None = None,
    tenant: TenantContext = Depends(get_tenant),
    db: Session = Depends(get_db),
) -> dict:
    """This week's filming checklist for salon staff."""
    checklist, cost = footage_service.generate_capture_checklist(
        db, tenant.client_id, week_of=week_of
    )
    return {"checklist": checklist, "cost_usd": cost}
