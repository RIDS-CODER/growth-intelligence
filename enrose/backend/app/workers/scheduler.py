"""Background jobs.

Job functions are pure and queue-agnostic, so moving from this in-process loop to
RQ, Celery or n8n in Phase 2 means changing the caller, not the work.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from sqlalchemy import select

from app.config import settings
from app.db import SessionLocal
from app.models.tenancy import Client
from app.services import analytics_service, publishing_service

log = logging.getLogger(__name__)


def publish_due_posts() -> dict[str, int]:
    """Publish everything currently due, across all clients."""
    with SessionLocal() as db:
        result = publishing_service.run_due(db)
        if result["published"] or result["failed"]:
            log.info("publisher tick: %s", result)
        return result


def ingest_all_metrics() -> dict[str, int]:
    """Refresh metrics for every client."""
    written = 0
    with SessionLocal() as db:
        for client in db.execute(select(Client)).scalars().all():
            written += analytics_service.ingest_metrics(db, client.id)
    return {"snapshots_written": written}


def weekly_learning_cycle() -> list[dict[str, Any]]:
    """The loop that makes next cycle differ from this one."""
    results = []
    with SessionLocal() as db:
        for client in db.execute(select(Client)).scalars().all():
            try:
                results.append(
                    {"client": client.slug, **analytics_service.run_learning_cycle(db, client.id)}
                )
            except Exception as exc:  # noqa: BLE001 - one client must not block the rest
                log.exception("learning cycle failed for %s", client.slug)
                results.append({"client": client.slug, "error": str(exc)})
    return results


def run_forever() -> None:  # pragma: no cover - long-running loop
    """Minimal in-process scheduler for single-instance deployments."""
    if not settings.scheduler_enabled:
        log.info("Scheduler disabled (SCHEDULER_ENABLED=false). Exiting.")
        return

    log.info("Scheduler started, tick=%ss", settings.scheduler_tick_seconds)
    ticks = 0
    while True:
        try:
            publish_due_posts()
            # Metrics hourly rather than every tick — Graph API quota is finite.
            if ticks % max(1, 3600 // settings.scheduler_tick_seconds) == 0:
                ingest_all_metrics()
        except Exception:  # noqa: BLE001 - a worker crash must not kill the loop
            log.exception("scheduler tick failed")
        ticks += 1
        time.sleep(settings.scheduler_tick_seconds)


if __name__ == "__main__":  # pragma: no cover
    run_forever()
