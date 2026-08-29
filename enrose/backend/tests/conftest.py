"""Test fixtures.

Every test runs against a fresh in-memory SQLite database with the mock AI and mock
Instagram providers, so the suite needs no services, no network and no credentials.
"""

from __future__ import annotations

import os

# Must be set before app.config is imported anywhere.
os.environ.setdefault("DATABASE_URL", "sqlite://")
os.environ.setdefault("ANTHROPIC_API_KEY", "")
os.environ.setdefault("META_APP_ID", "")
os.environ.setdefault("STORAGE_PROVIDER", "local")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import get_db
from app.main import app
from app.models.base import Base
from app.seed.enrose import DEFAULT_EMAIL, DEFAULT_PASSWORD, seed


@pytest.fixture
def engine():
    # StaticPool keeps one connection alive so an in-memory DB survives across
    # sessions within a single test.
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def db(engine) -> Session:
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)
    session = factory()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def seeded(db: Session) -> dict:
    """A fully seeded Enrose tenant."""
    return seed(db)


@pytest.fixture
def client_id(seeded) -> "uuid.UUID":  # noqa: F821
    import uuid

    return uuid.UUID(seeded["client_id"])


@pytest.fixture
def api(engine, seeded) -> TestClient:
    """Authenticated TestClient bound to the test database."""
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)

    def override_get_db():
        session = factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    test_client = TestClient(app)
    login = test_client.post(
        "/api/v1/auth/login", json={"email": DEFAULT_EMAIL, "password": DEFAULT_PASSWORD}
    )
    assert login.status_code == 200, login.text
    test_client.headers.update({"Authorization": f"Bearer {login.json()['access_token']}"})
    yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def mock_provider():
    from app.llm.provider import MockProvider

    return MockProvider()
