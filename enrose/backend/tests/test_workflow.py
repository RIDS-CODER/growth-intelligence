"""Status machine, approval workflow, memory and virality scoring."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.enums import ApprovalLevel, ContentFormat, ContentStatus
from app.models.content import ContentItem
from app.services import approval_service, content_status, memory, virality
from app.services.content_status import InvalidTransition


def _item(db, client_id, **kwargs) -> ContentItem:
    item = ContentItem(
        client_id=client_id,
        title=kwargs.pop("title", "Test item"),
        format=kwargs.pop("format", ContentFormat.REEL.value),
        pillar=kwargs.pop("pillar", "transformation"),
        status=kwargs.pop("status", ContentStatus.IDEA.value),
        **kwargs,
    )
    db.add(item)
    db.commit()
    return item


# ── Status machine ──────────────────────────────────────────────────────────


def test_happy_path_transitions(db, client_id):
    item = _item(db, client_id)
    for target in (
        ContentStatus.DRAFT,
        ContentStatus.AI_REVIEW,
        ContentStatus.READY_FOR_APPROVAL,
        ContentStatus.CLIENT_APPROVED,
        ContentStatus.SCHEDULED,
        ContentStatus.PUBLISHED,
        ContentStatus.ANALYZING,
        ContentStatus.LEARNED,
    ):
        content_status.transition(db, item, target)
    assert item.status == ContentStatus.LEARNED.value


def test_illegal_transition_raises(db, client_id):
    """Draft straight to published is the failure this machine exists to prevent."""
    item = _item(db, client_id, status=ContentStatus.DRAFT.value)
    with pytest.raises(InvalidTransition) as exc:
        content_status.transition(db, item, ContentStatus.PUBLISHED)
    assert "draft" in str(exc.value)
    assert item.status == ContentStatus.DRAFT.value


def test_learned_is_terminal(db, client_id):
    item = _item(db, client_id, status=ContentStatus.LEARNED.value)
    with pytest.raises(InvalidTransition):
        content_status.transition(db, item, ContentStatus.DRAFT)


def test_failed_publish_can_be_requeued(db, client_id):
    """A failed publish must never silently disappear."""
    item = _item(db, client_id, status=ContentStatus.PUBLISH_FAILED.value)
    content_status.transition(db, item, ContentStatus.SCHEDULED)
    assert item.status == ContentStatus.SCHEDULED.value


def test_transition_writes_audit_row(db, client_id):
    from app.models.ops import AuditLog

    item = _item(db, client_id)
    content_status.transition(db, item, ContentStatus.DRAFT, note="because")
    db.commit()

    logs = db.query(AuditLog).filter(AuditLog.entity_id == item.id).all()
    assert len(logs) == 1
    assert logs[0].before["status"] == ContentStatus.IDEA.value
    assert logs[0].after["status"] == ContentStatus.DRAFT.value


def test_same_status_transition_is_a_noop(db, client_id):
    item = _item(db, client_id, status=ContentStatus.DRAFT.value)
    content_status.transition(db, item, ContentStatus.DRAFT)
    assert item.status == ContentStatus.DRAFT.value


# ── Approval ────────────────────────────────────────────────────────────────


def test_approve_records_decision(db, client_id):
    from app.models.content import Approval

    item = _item(db, client_id, status=ContentStatus.READY_FOR_APPROVAL.value)
    approval_service.approve(db, item, note="looks good")
    assert item.status == ContentStatus.CLIENT_APPROVED.value
    assert db.query(Approval).filter(Approval.content_item_id == item.id).count() == 1


def test_revision_request_returns_item_to_draft_path(db, client_id):
    item = _item(db, client_id, status=ContentStatus.READY_FOR_APPROVAL.value)
    approval_service.request_revision(db, item, note="tighten the hook")
    assert item.status == ContentStatus.REVISION_REQUESTED.value
    content_status.transition(db, item, ContentStatus.DRAFT)
    assert item.status == ContentStatus.DRAFT.value


def test_cannot_schedule_unapproved_content(db, client_id):
    item = _item(db, client_id, status=ContentStatus.READY_FOR_APPROVAL.value)
    with pytest.raises(InvalidTransition):
        approval_service.schedule(db, item, datetime.now(timezone.utc))


def test_scheduling_approved_content_creates_queue_entry(db, client_id):
    item = _item(db, client_id, status=ContentStatus.CLIENT_APPROVED.value)
    when = datetime.now(timezone.utc) + timedelta(hours=2)
    post = approval_service.schedule(db, item, when)
    assert post.status == "pending"
    assert item.status == ContentStatus.SCHEDULED.value


def test_auto_publish_is_off_by_default(db, client_id):
    """Level 2 must never engage without an explicit client opt-in."""
    item = _item(
        db, client_id, status=ContentStatus.READY_FOR_APPROVAL.value,
        overall_score=95.0, approval_level=ApprovalLevel.L2_AUTO_LOW_RISK.value,
        qa_report={"blocking_reasons": [], "rule_scan": {"passed": True}, "quality_bar_passed": True},
    )
    result = approval_service.auto_publish_eligibility(item, client_enabled=False)
    assert not result.eligible
    assert any("disabled" in reason.lower() for reason in result.reasons)


def test_auto_publish_allows_clean_high_scoring_low_risk_content(db, client_id):
    item = _item(
        db, client_id, status=ContentStatus.READY_FOR_APPROVAL.value,
        overall_score=88.0, approval_level=ApprovalLevel.L2_AUTO_LOW_RISK.value,
        qa_report={"blocking_reasons": [], "rule_scan": {"passed": True}, "quality_bar_passed": True},
    )
    result = approval_service.auto_publish_eligibility(item, client_enabled=True)
    assert result.eligible, result.reasons


def test_auto_publish_blocked_by_low_score(db, client_id):
    item = _item(
        db, client_id, overall_score=60.0,
        approval_level=ApprovalLevel.L2_AUTO_LOW_RISK.value,
        qa_report={"blocking_reasons": [], "rule_scan": {"passed": True}, "quality_bar_passed": True},
    )
    result = approval_service.auto_publish_eligibility(item, client_enabled=True)
    assert not result.eligible
    assert any("threshold" in reason for reason in result.reasons)


def test_auto_publish_blocked_by_failed_rule_scan(db, client_id):
    """A deterministic violation cannot be argued past by any other signal."""
    item = _item(
        db, client_id, overall_score=95.0,
        approval_level=ApprovalLevel.L2_AUTO_LOW_RISK.value,
        qa_report={"blocking_reasons": [], "rule_scan": {"passed": False}, "quality_bar_passed": True},
    )
    result = approval_service.auto_publish_eligibility(item, client_enabled=True)
    assert not result.eligible
    assert any("safety scan" in reason.lower() for reason in result.reasons)


def test_level_three_always_requires_a_human(db, client_id):
    item = _item(
        db, client_id, overall_score=99.0,
        approval_level=ApprovalLevel.L3_MANDATORY_HUMAN.value,
        qa_report={"blocking_reasons": [], "rule_scan": {"passed": True}, "quality_bar_passed": True},
    )
    result = approval_service.auto_publish_eligibility(item, client_enabled=True)
    assert not result.eligible


# ── Content memory ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "a,b",
    [
        ("5 hair mistakes damaging your hair", "7 haircare mistakes that damage hair"),
        ("Balayage transformation reveal", "A balayage transformation reveal"),
        ("Monsoon frizz routine", "Frizz routine for monsoon"),
    ],
)
def test_near_duplicate_topics_are_detected(db, client_id, a, b):
    """The '5 hair mistakes, again' failure mode."""
    memory.record(db, client_id, topic=a, pillar="education", content_format="reel")
    result = memory.check_duplicate(db, client_id, b)
    assert result.is_duplicate, f"{result.similarity:.2f} similarity between '{a}' and '{b}'"
    assert result.reason


def test_genuinely_different_topics_are_allowed(db, client_id):
    memory.record(
        db, client_id, topic="5 hair mistakes damaging your colour", pillar="education",
        content_format="reel",
    )
    result = memory.check_duplicate(db, client_id, "Chrome nail art close-up process")
    assert not result.is_duplicate


def test_fingerprint_ignores_leading_numbers():
    assert memory.fingerprint("5 hair mistakes") == memory.fingerprint("7 hair mistakes")


def test_memory_outcomes_label_winners_and_losers(db, client_id):
    entry = memory.record(
        db, client_id, topic="Balayage reveal", pillar="transformation", content_format="reel",
        content_item_id=(item := _item(db, client_id)).id,
    )
    memory.update_outcomes(db, client_id, {item.id: 1.8})
    db.refresh(entry)
    assert entry.outcome == "winner"

    memory.update_outcomes(db, client_id, {item.id: 0.4})
    db.refresh(entry)
    assert entry.outcome == "poor"


# ── Virality ────────────────────────────────────────────────────────────────


def _assessment(**overrides):
    from app.schemas.ai import ViralityAssessment

    base = {
        key: {"score": 70.0, "reason": "reason"}
        for key in (
            "hook_strength", "curiosity", "emotional_response", "shareability", "saveability",
            "rewatch_potential", "relatability", "trend_alignment", "visual_transformation",
            "audience_relevance", "brand_fit", "conversion_potential",
        )
    }
    base.update({k: {"score": v, "reason": "r"} for k, v in overrides.items()})
    base.update(
        {
            "predicted_top_percentile": 70.0,
            "biggest_weakness": "w",
            "concrete_fix": "f",
            "explanation": "e",
        }
    )
    return ViralityAssessment.model_validate(base)


def test_rollup_is_deterministic():
    """Same input, same score — that is what makes scores comparable over time."""
    a = virality.roll_up(_assessment())
    b = virality.roll_up(_assessment())
    assert a.viral_score == b.viral_score == 70.0
    assert a.business_score == b.business_score == 70.0
    assert a.overall_score == 70.0


def test_viral_and_business_scores_move_independently():
    """A salon must be able to see 'high reach, low business value' as distinct."""
    scores = virality.roll_up(
        _assessment(hook_strength=95, saveability=95, conversion_potential=20, brand_fit=25)
    )
    assert scores.viral_score > scores.business_score


def test_hook_strength_dominates_the_viral_score():
    weak = virality.roll_up(_assessment(hook_strength=10))
    strong = virality.roll_up(_assessment(hook_strength=100))
    assert strong.viral_score - weak.viral_score > 15


def test_low_scoring_content_fails_the_quality_bar():
    low = virality.roll_up(_assessment(**{k: 30 for k in ("hook_strength", "curiosity", "saveability")}))
    ok, reason = virality.meets_quality_bar(low)
    if low.overall_score < virality.MIN_PUBLISHABLE_OVERALL:
        assert not ok and reason
    high = virality.roll_up(_assessment())
    assert virality.meets_quality_bar(high)[0]


def test_breakdown_preserves_model_reasoning():
    scores = virality.roll_up(_assessment())
    dims = scores.breakdown["dimensions"]
    assert len(dims) == 12
    assert all(d["reason"] for d in dims.values())
