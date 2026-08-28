"""Approval workflow and auto-publish eligibility.

Level 2 (auto-publish) eligibility is decided here, in tested Python, rather than
in a prompt. Auto-publishing is off unless a client explicitly enables it, and even
then it applies only to content that clears every one of the conditions below.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.enums import ActorType, ApprovalDecision, ApprovalLevel, ContentStatus
from app.models.content import Approval, ContentItem
from app.models.publishing import ScheduledPost, SocialAccount
from app.services import content_status

# A draft must beat this to be eligible for hands-off publishing.
AUTO_PUBLISH_MIN_OVERALL = 75.0


@dataclass
class EligibilityResult:
    eligible: bool
    reasons: list[str]


def auto_publish_eligibility(item: ContentItem, *, client_enabled: bool) -> EligibilityResult:
    """Decide whether an item may skip human approval.

    Every reason is collected rather than short-circuiting, so the UI can explain
    the full set of things standing between a draft and hands-off publishing.
    """
    reasons: list[str] = []

    if not client_enabled:
        reasons.append("Auto-publish is disabled for this client.")
    if item.approval_level == ApprovalLevel.L3_MANDATORY_HUMAN.value:
        reasons.append("Item is level 3 (campaign, offer or claim): human approval is mandatory.")
    if item.approval_level != ApprovalLevel.L2_AUTO_LOW_RISK.value and client_enabled:
        reasons.append("Item is not marked as low-risk (level 2).")

    qa = item.qa_report or {}
    if not qa:
        reasons.append("No QA report on this item.")
    else:
        if qa.get("blocking_reasons"):
            reasons.append("QA recorded blocking findings.")
        if not (qa.get("rule_scan") or {}).get("passed", False):
            reasons.append("Deterministic safety scan did not pass.")
        if not qa.get("quality_bar_passed", True):
            reasons.append("Item is below the quality bar.")

    if item.overall_score is None or item.overall_score < AUTO_PUBLISH_MIN_OVERALL:
        reasons.append(
            f"Overall score {item.overall_score if item.overall_score is not None else 'n/a'} "
            f"is below the auto-publish threshold of {AUTO_PUBLISH_MIN_OVERALL}."
        )

    if item.campaign_id is not None:
        reasons.append("Item belongs to a campaign; campaigns always require human approval.")

    return EligibilityResult(eligible=not reasons, reasons=reasons)


def _require_transition(item: ContentItem, target: ContentStatus) -> None:
    """Reject a decision that is not legal from the item's current state.

    `content_status.transition` treats a same-status move as a no-op, which is right
    for idempotent internal calls but wrong here: silently accepting a second
    approval would write a duplicate approval record and tell the client their
    click did something new.
    """
    current = ContentStatus(item.status)
    if not content_status.can_transition(current, target):
        raise content_status.InvalidTransition(
            f"Cannot {target.value.replace('_', ' ')} content in state '{current.value}'."
        )


def _record(
    db: Session,
    item: ContentItem,
    decision: ApprovalDecision,
    *,
    actor_id: uuid.UUID | None,
    actor_type: ActorType,
    note: str | None,
) -> Approval:
    row = Approval(
        client_id=item.client_id,
        content_item_id=item.id,
        decision=decision.value,
        level=item.approval_level,
        actor_type=actor_type.value,
        actor_id=actor_id,
        note=note,
    )
    db.add(row)
    db.flush()
    return row


def approve(
    db: Session,
    item: ContentItem,
    *,
    actor_id: uuid.UUID | None = None,
    actor_type: ActorType = ActorType.USER,
    note: str | None = None,
) -> ContentItem:
    _require_transition(item, ContentStatus.CLIENT_APPROVED)
    content_status.transition(
        db, item, ContentStatus.CLIENT_APPROVED, actor_type=actor_type, actor_id=actor_id, note=note
    )
    _record(db, item, ApprovalDecision.APPROVED, actor_id=actor_id, actor_type=actor_type, note=note)
    db.commit()
    db.refresh(item)
    return item


def reject(
    db: Session,
    item: ContentItem,
    *,
    actor_id: uuid.UUID | None = None,
    actor_type: ActorType = ActorType.USER,
    note: str | None = None,
) -> ContentItem:
    _require_transition(item, ContentStatus.REJECTED)
    content_status.transition(
        db, item, ContentStatus.REJECTED, actor_type=actor_type, actor_id=actor_id, note=note
    )
    _record(db, item, ApprovalDecision.REJECTED, actor_id=actor_id, actor_type=actor_type, note=note)
    db.commit()
    db.refresh(item)
    return item


def request_revision(
    db: Session,
    item: ContentItem,
    *,
    actor_id: uuid.UUID | None = None,
    actor_type: ActorType = ActorType.USER,
    note: str | None = None,
) -> ContentItem:
    _require_transition(item, ContentStatus.REVISION_REQUESTED)
    content_status.transition(
        db, item, ContentStatus.REVISION_REQUESTED, actor_type=actor_type, actor_id=actor_id, note=note
    )
    _record(
        db, item, ApprovalDecision.REVISION_REQUESTED, actor_id=actor_id, actor_type=actor_type, note=note
    )
    db.commit()
    db.refresh(item)
    return item


def schedule(
    db: Session,
    item: ContentItem,
    publish_at: datetime,
    *,
    actor_id: uuid.UUID | None = None,
) -> ScheduledPost:
    """Queue an approved item for publishing."""
    if ContentStatus(item.status) is not ContentStatus.CLIENT_APPROVED:
        raise content_status.InvalidTransition(
            f"Only client-approved content can be scheduled; this item is '{item.status}'."
        )
    if publish_at.tzinfo is None:
        publish_at = publish_at.replace(tzinfo=timezone.utc)

    account = db.execute(
        select(SocialAccount).where(
            SocialAccount.client_id == item.client_id,
            SocialAccount.platform == "instagram",
            SocialAccount.is_active.is_(True),
        )
    ).scalars().first()

    post = ScheduledPost(
        client_id=item.client_id,
        content_item_id=item.id,
        social_account_id=account.id if account else None,
        publish_at=publish_at,
        provider="mock" if (account is None or account.is_mock) else "graph_api",
    )
    db.add(post)
    item.scheduled_for = publish_at
    content_status.transition(
        db, item, ContentStatus.SCHEDULED, actor_type=ActorType.USER, actor_id=actor_id
    )
    db.commit()
    db.refresh(post)
    return post


def approval_queue(db: Session, client_id: uuid.UUID, limit: int = 50) -> list[ContentItem]:
    return list(
        db.execute(
            select(ContentItem)
            .where(
                ContentItem.client_id == client_id,
                ContentItem.status == ContentStatus.READY_FOR_APPROVAL.value,
            )
            .order_by(ContentItem.overall_score.desc().nullslast())
            .limit(limit)
        ).scalars().all()
    )
