"""The content status machine.

Nothing writes `ContentItem.status` directly. Every transition goes through
`transition()`, which validates it against an explicit map and writes an audit row.
An illegal jump (draft straight to published) raises rather than silently
corrupting the pipeline.
"""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from app.enums import ActorType, ContentStatus
from app.models.content import ContentItem
from app.models.ops import AuditLog


class InvalidTransition(ValueError):
    """Raised when a status change is not permitted from the current state."""


S = ContentStatus

ALLOWED: dict[ContentStatus, set[ContentStatus]] = {
    S.IDEA: {S.DRAFT, S.REJECTED},
    S.DRAFT: {S.AI_REVIEW, S.REJECTED},
    S.AI_REVIEW: {S.READY_FOR_APPROVAL, S.REJECTED, S.DRAFT},
    S.READY_FOR_APPROVAL: {S.CLIENT_APPROVED, S.REJECTED, S.REVISION_REQUESTED},
    S.REVISION_REQUESTED: {S.DRAFT, S.REJECTED},
    S.CLIENT_APPROVED: {S.SCHEDULED, S.REVISION_REQUESTED, S.REJECTED},
    S.SCHEDULED: {S.PUBLISHED, S.PUBLISH_FAILED, S.CLIENT_APPROVED},
    # A failed publish returns to SCHEDULED for retry; it never silently disappears.
    S.PUBLISH_FAILED: {S.SCHEDULED, S.REJECTED},
    S.PUBLISHED: {S.ANALYZING},
    S.ANALYZING: {S.LEARNED, S.ANALYZING},
    S.LEARNED: set(),
    S.REJECTED: {S.DRAFT},
}


def can_transition(current: ContentStatus, target: ContentStatus) -> bool:
    return target in ALLOWED.get(current, set())


def transition(
    db: Session,
    item: ContentItem,
    target: ContentStatus,
    *,
    actor_type: ActorType = ActorType.SYSTEM,
    actor_id: uuid.UUID | None = None,
    actor_label: str | None = None,
    note: str | None = None,
) -> ContentItem:
    current = ContentStatus(item.status)
    if current == target:
        return item
    if not can_transition(current, target):
        raise InvalidTransition(
            f"Cannot move content {item.id} from '{current.value}' to '{target.value}'. "
            f"Allowed from here: {sorted(s.value for s in ALLOWED.get(current, set())) or 'none'}"
        )

    item.status = target.value
    db.add(
        AuditLog(
            client_id=item.client_id,
            actor_type=actor_type.value,
            actor_id=actor_id,
            actor_label=actor_label,
            action="content.status_change",
            entity="content_item",
            entity_id=item.id,
            before={"status": current.value},
            after={"status": target.value},
            note=note,
        )
    )
    db.flush()
    return item
