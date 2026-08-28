"""Database engine, session factory and the portable column types.

Production is PostgreSQL; the test suite runs the identical models on SQLite so it
needs no services and no network. That portability is why `JSONType` exists rather
than a bare `JSONB` import.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from sqlalchemy import JSON, create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

_is_sqlite = settings.database_url.startswith("sqlite")

engine = create_engine(
    settings.database_url,
    # SQLite in tests is shared across FastAPI's threadpool; Postgres pools normally.
    connect_args={"check_same_thread": False} if _is_sqlite else {},
    pool_pre_ping=not _is_sqlite,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)

# JSONB on Postgres (indexable, queryable), plain JSON on SQLite.
JSONType: Any = JSON().with_variant(JSONB(), "postgresql")


def get_db() -> Iterator[Session]:
    """FastAPI dependency: one session per request, always closed."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_all() -> None:
    """Create the schema directly.

    Used by tests and by first-run local development. Production uses Alembic —
    see `alembic/versions/0001_initial.py`.
    """
    from app import models  # noqa: F401  (import registers every mapper)
    from app.models.base import Base

    Base.metadata.create_all(bind=engine)
