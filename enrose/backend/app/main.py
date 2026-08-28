"""FastAPI application entrypoint."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models.tenancy import Client
from app.schemas.api import ClientOut
from app.security import TenantContext, get_tenant

logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO))

app = FastAPI(
    title="Enrose AI Social Autopilot",
    description=(
        "AI Social Media Manager for Enrose Salon. Claude is the brain; this API is the body. "
        "Subsystems without credentials degrade to clearly-labelled mocks — never to fake success."
    ),
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api/v1")

from app.api.v1 import analytics, assets, auth, brands, command, content, strategy  # noqa: E402

api.include_router(auth.router)
api.include_router(brands.router)
api.include_router(content.router)
api.include_router(strategy.router)
api.include_router(assets.router)
api.include_router(analytics.router)
api.include_router(command.router)


@api.get("/clients", response_model=list[ClientOut], tags=["clients"])
def list_clients(
    tenant: TenantContext = Depends(get_tenant), db: Session = Depends(get_db)
) -> list[Client]:
    """Clients this principal can access. Single-tenant today, ready for many."""
    return list(db.execute(select(Client).where(Client.id == tenant.client_id)).scalars().all())


app.include_router(api)


@app.get("/health", tags=["ops"])
def health() -> dict:
    """Liveness plus an honest statement of which subsystems are real."""
    return {
        "status": "ok",
        "version": app.version,
        "environment": settings.app_env,
        "providers": {
            "ai": "anthropic" if settings.ai_live else "mock",
            "instagram": "graph_api" if settings.instagram_live else "mock",
            "storage": "s3" if settings.storage_live else "local",
            "auth": "supabase" if settings.supabase_live else "local_jwt",
        },
        "models": {
            "strong": settings.model_strong,
            "balanced": settings.model_balanced,
            "cheap": settings.model_cheap,
        },
    }


@app.on_event("startup")
def on_startup() -> None:
    # Convenience for SQLite development; production schema is owned by Alembic.
    if settings.database_url.startswith("sqlite"):
        from app.db import create_all

        create_all()
