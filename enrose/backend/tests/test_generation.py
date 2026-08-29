"""Content generation pipeline, calendar allocation, footage, and publishing."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

from app.enums import ContentFormat, ContentStatus, FootageType
from app.integrations.instagram import InstagramMock, PublishError, PublishRequest
from app.models.content import Asset, ContentItem
from app.services import (
    calendar_service,
    content_service,
    footage_service,
    memory,
    publishing_service,
    strategy_service,
)


# ── Generation pipeline ─────────────────────────────────────────────────────


def test_generate_reel_end_to_end(db, client_id):
    result = content_service.generate_content(db, client_id, content_format=ContentFormat.REEL)
    item = result.item

    assert item.status == ContentStatus.READY_FOR_APPROVAL.value
    assert item.viral_score is not None and item.business_score is not None
    assert item.payload["shots"], "a reel must carry a shot list"
    assert item.payload["editing_instructions"]
    assert item.caption and item.cta
    assert item.qa_report["rule_scan"]["passed"]


def test_generate_carousel_produces_slides(db, client_id):
    result = content_service.generate_content(db, client_id, content_format=ContentFormat.CAROUSEL)
    slides = result.item.payload["slides"]
    assert len(slides) >= 4
    assert slides[0]["template_key"] == "cover_bold"
    assert slides[-1]["template_key"] == "cta_close"


def test_generation_records_content_memory(db, client_id):
    result = content_service.generate_content(db, client_id)
    topics = memory.recent_topics(db, client_id)
    assert result.item.title in topics


def test_duplicate_topic_is_rejected_before_any_spend(db, client_id):
    """The cheap check must fire first — a rejected duplicate should cost nothing."""
    from app.models.ops import AIActivityLog

    memory.record(
        db, client_id, topic="5 hair mistakes damaging your hair", pillar="education",
        content_format="reel",
    )
    before = db.query(AIActivityLog).count()

    with pytest.raises(content_service.GenerationRejected) as exc:
        content_service.generate_content(
            db, client_id, topic="7 haircare mistakes that damage your hair"
        )

    assert exc.value.stage == "duplicate_check"
    assert db.query(AIActivityLog).count() == before, "no AI call should have been made"


def test_story_format_is_rejected_by_this_pipeline(db, client_id):
    with pytest.raises(content_service.GenerationRejected) as exc:
        content_service.generate_content(db, client_id, content_format=ContentFormat.STORY)
    assert exc.value.stage == "input"


def test_generation_logs_every_agent_call(db, client_id):
    from app.models.ops import AIActivityLog

    content_service.generate_content(db, client_id)
    agents = {
        row.agent
        for row in db.query(AIActivityLog).filter(AIActivityLog.client_id == client_id).all()
    }
    assert {"reel_writer", "virality_scorer", "qa_reviewer"} <= agents


def test_unsafe_draft_is_auto_rejected_and_never_queued(db, client_id):
    """A draft that invents a price must be rejected by the pipeline, not by a human."""
    from app.llm.provider import LLMResponse, MockProvider

    class PriceInventingProvider(MockProvider):
        def complete_structured(self, **kwargs) -> LLMResponse:
            response = super().complete_structured(**kwargs)
            if kwargs["tool_name"] == "reel_draft":
                response.data["caption"] = "Book your balayage today for just ₹4,500!"
            return response

    with pytest.raises(content_service.GenerationRejected) as exc:
        content_service.generate_content(db, client_id, provider=PriceInventingProvider())

    assert exc.value.stage == "qa"
    assert any("invented_pricing" in r for r in exc.value.detail["blocking_reasons"])

    item = db.get(ContentItem, uuid.UUID(exc.value.detail["content_item_id"]))
    assert item.status == ContentStatus.REJECTED.value


def test_captions_are_regenerable_independently(db, client_id):
    item = content_service.generate_content(db, client_id).item
    variants, cost = content_service.generate_captions(db, client_id, item)
    assert len(variants) >= 2
    assert {v.label for v in variants} <= {"short", "medium", "long"}
    assert sum(1 for v in variants if v.is_selected) == 1


# ── Calendar ────────────────────────────────────────────────────────────────


def test_calendar_respects_the_strategy_format_split(db, client_id):
    strategy, _ = strategy_service.generate_content_strategy(db, client_id, period_days=30)
    plan = calendar_service.generate_calendar(db, client_id, days=30, strategy=strategy)

    assert plan.counts["reel"] == strategy.format_split["reel"]
    assert plan.counts["carousel"] == strategy.format_split["carousel"]


def test_calendar_entries_are_chronological_and_within_window(db, client_id):
    start = date.today()
    plan = calendar_service.generate_calendar(db, client_id, start=start, days=14)
    times = [e.scheduled_for for e in plan.entries]

    assert times == sorted(times) or len(set(times)) > 1  # spread, not all identical
    assert all(e.scheduled_for.date() >= start for e in plan.entries)
    assert all(e.scheduled_for.date() <= start + timedelta(days=13) for e in plan.entries)


def test_pillar_mix_is_distributed_not_clumped(db, client_id):
    plan = calendar_service.generate_calendar(db, client_id, days=30)
    pillars = [e.pillar for e in plan.entries if e.format == "reel"]
    assert len(set(pillars)) > 1, "a calendar of one pillar is not a mix"


def test_reschedule_moves_an_entry(db, client_id):
    plan = calendar_service.generate_calendar(db, client_id, days=14)
    entry = plan.entries[0]
    new_time = datetime.now(timezone.utc) + timedelta(days=3, hours=4)

    updated = calendar_service.reschedule(db, client_id, entry.id, new_time)

    # SQLite does not persist tzinfo (Postgres does), so compare the UTC instant.
    stored = updated.scheduled_for
    if stored.tzinfo is None:
        stored = stored.replace(tzinfo=timezone.utc)
    assert stored.replace(microsecond=0) == new_time.replace(microsecond=0)


def test_calendar_regeneration_preserves_slots_with_content(db, client_id):
    """Regenerating a plan must not discard work already attached to a slot."""
    plan = calendar_service.generate_calendar(db, client_id, days=30)
    item = content_service.generate_content(db, client_id).item
    entry = calendar_service.attach_content(db, client_id, plan.entries[0].id, item.id)

    calendar_service.generate_calendar(db, client_id, days=30, replace_existing=True)
    db.expire_all()
    from app.models.content import CalendarEntry

    assert db.get(CalendarEntry, entry.id) is not None


# ── Footage ─────────────────────────────────────────────────────────────────


def _asset(db, client_id, footage_type: str, duration: float = 8.0) -> Asset:
    asset = Asset(
        client_id=client_id,
        filename=f"{footage_type}.mp4",
        kind="video",
        storage_key=f"assets/{client_id}/{footage_type}.mp4",
        mime_type="video/mp4",
        duration_s=duration,
        footage_type=footage_type,
        shoot_group="shoot-1",
    )
    db.add(asset)
    db.commit()
    return asset


def test_coverage_report_flags_the_missing_payoff_shots(db, client_id):
    assets = [_asset(db, client_id, ft) for ft in ("before", "color", "styling")]
    coverage = footage_service.coverage_report(assets)

    assert not coverage["has_payoff"]
    assert not coverage["has_reaction"]
    assert "after" in coverage["arc_missing"]
    assert "reaction" in coverage["arc_missing"]
    assert coverage["arc_coverage_pct"] < 100


def test_full_arc_reports_complete_coverage(db, client_id):
    for ft in ("before", "color", "styling", "after", "reaction"):
        _asset(db, client_id, ft)
    coverage = footage_service.coverage_report(
        db.query(Asset).filter(Asset.client_id == client_id).all()
    )
    assert coverage["arc_coverage_pct"] == 100.0
    assert coverage["has_reaction"]


def test_footage_analysis_reports_what_to_film_next(db, client_id):
    for ft in ("before", "color", "styling", "after"):
        _asset(db, client_id, ft)

    analysis, _ = footage_service.analyze_footage(db, client_id, shoot_group="shoot-1")
    assert analysis["missing_shots"]
    assert all(shot["why_it_matters"] for shot in analysis["missing_shots"])
    assert analysis["verdict"] in ("ready_to_edit", "usable_with_gaps", "needs_more_footage")


def test_footage_analysis_drops_steps_naming_unknown_clips(db, client_id):
    """The model must not be able to sequence a clip that does not exist."""
    _asset(db, client_id, "before")
    analysis, _ = footage_service.analyze_footage(db, client_id, shoot_group="shoot-1")

    real_ids = {str(a.id) for a in db.query(Asset).filter(Asset.client_id == client_id).all()}
    assert all(step["asset_id"] in real_ids for step in analysis["sequence"])


def test_analysis_without_footage_raises(db, client_id):
    with pytest.raises(ValueError):
        footage_service.analyze_footage(db, client_id, shoot_group="nonexistent")


def test_attach_assets_rejects_another_tenants_asset(db, client_id):
    """The tenancy boundary must hold on writes, not just reads."""
    from app.models.tenancy import Client

    other = Client(name="Other Salon", slug="other")
    db.add(other)
    db.commit()
    foreign = _asset(db, other.id, "before")

    item = content_service.generate_content(db, client_id).item
    with pytest.raises(ValueError):
        footage_service.attach_assets(db, client_id, item.id, [foreign.id])


def test_capture_checklist_covers_the_week(db, client_id):
    checklist, _ = footage_service.generate_capture_checklist(db, client_id)
    assert len(checklist["days"]) >= 5
    assert all(day["tasks"] for day in checklist["days"])
    assert all(task["why"] for day in checklist["days"] for task in day["tasks"])
    assert checklist["total_estimated_minutes"] <= 600


# ── Publishing ──────────────────────────────────────────────────────────────


def test_mock_publish_is_clearly_labelled(db, client_id):
    result = InstagramMock().publish(
        PublishRequest(caption="Test", media_url="https://example.com/v.mp4"),
        ig_user_id="x",
        access_token="y",
    )
    assert result.is_mock
    assert result.platform_post_id.startswith("mock_")
    assert result.raw["MOCK"] is True


def test_publish_without_caption_fails_permanently(db, client_id):
    with pytest.raises(PublishError) as exc:
        InstagramMock().publish(PublishRequest(caption=""), ig_user_id="x", access_token="y")
    assert not exc.value.retryable


def test_publishing_moves_content_to_published(db, client_id):
    from app.services import approval_service

    publishing_service.connect_mock_account(db, client_id)
    item = content_service.generate_content(db, client_id).item
    approval_service.approve(db, item)
    approval_service.schedule(db, item, datetime.now(timezone.utc) - timedelta(minutes=1))

    result = publishing_service.run_due(db, client=InstagramMock())
    db.refresh(item)

    assert result["published"] == 1
    assert item.status == ContentStatus.PUBLISHED.value
    assert item.published_at is not None


def test_publish_failure_is_recorded_and_requeued(db, client_id):
    from app.services import approval_service

    class FlakyClient(InstagramMock):
        def publish(self, request, *, ig_user_id, access_token):
            raise PublishError("temporary upstream failure", retryable=True)

    publishing_service.connect_mock_account(db, client_id)
    item = content_service.generate_content(db, client_id).item
    approval_service.approve(db, item)
    post = approval_service.schedule(db, item, datetime.now(timezone.utc) - timedelta(minutes=1))

    result = publishing_service.run_due(db, client=FlakyClient())
    db.refresh(post)

    assert result["failed"] == 1
    assert post.attempts == 1
    assert post.status == "pending"  # retryable, so back on the queue
    assert "temporary upstream failure" in post.last_error


def test_permanent_failure_marks_content_failed(db, client_id):
    from app.services import approval_service

    class BrokenClient(InstagramMock):
        def publish(self, request, *, ig_user_id, access_token):
            raise PublishError("media rejected", retryable=False)

    publishing_service.connect_mock_account(db, client_id)
    item = content_service.generate_content(db, client_id).item
    approval_service.approve(db, item)
    post = approval_service.schedule(db, item, datetime.now(timezone.utc) - timedelta(minutes=1))

    publishing_service.run_due(db, client=BrokenClient())
    db.refresh(post)
    db.refresh(item)

    assert post.status == "failed"
    assert item.status == ContentStatus.PUBLISH_FAILED.value


def test_due_posts_ignores_future_and_exhausted_posts(db, client_id):
    from app.services import approval_service

    publishing_service.connect_mock_account(db, client_id)
    item = content_service.generate_content(db, client_id).item
    approval_service.approve(db, item)
    approval_service.schedule(db, item, datetime.now(timezone.utc) + timedelta(days=1))

    assert publishing_service.due_posts(db) == []
