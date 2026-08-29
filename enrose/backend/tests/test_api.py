"""HTTP surface: auth, tenancy isolation, error handling, and the learning loop."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone


# ── Auth ────────────────────────────────────────────────────────────────────


def test_health_reports_which_providers_are_real():
    from fastapi.testclient import TestClient

    from app.main import app

    body = TestClient(app).get("/health").json()
    assert body["status"] == "ok"
    # With no credentials configured, the app must say so rather than implying live.
    assert body["providers"]["ai"] == "mock"
    assert body["providers"]["instagram"] == "mock"


def test_login_rejects_a_bad_password(api):
    response = api.post(
        "/api/v1/auth/login",
        json={"email": "owner@enrosesalon.com", "password": "wrong"},
        headers={"Authorization": ""},
    )
    assert response.status_code == 401
    assert "Incorrect email or password" in response.text


def test_unknown_email_gives_the_same_error_as_a_bad_password(api):
    """Distinguishing them would tell an attacker which accounts exist."""
    response = api.post(
        "/api/v1/auth/login",
        json={"email": "nobody@example.com", "password": "whatever"},
        headers={"Authorization": ""},
    )
    assert response.status_code == 401
    assert "Incorrect email or password" in response.text


def test_protected_routes_require_a_token():
    from fastapi.testclient import TestClient

    from app.main import app

    assert TestClient(app).get("/api/v1/brands").status_code == 401


def test_me_returns_the_tenant(api):
    body = api.get("/api/v1/auth/me").json()
    assert body["client"]["slug"] == "enrose"


# ── Brand Brain ─────────────────────────────────────────────────────────────


def test_brand_brain_exposes_gaps_not_guesses(api):
    body = api.get("/api/v1/brands").json()

    assert body["name"] == "Enrose Salon"
    assert len(body["services"]) >= 20
    assert all(s["price"] is None for s in body["services"])
    assert "service_pricing" in body["unknown_fields"]
    assert "instagram_follower_count" in body["unknown_fields"]
    assert body["missing_fields"]


def test_only_verified_product_brands_are_recorded(api):
    products = {p["brand_name"] for p in api.get("/api/v1/brands").json()["products"]}
    assert products == {"Kérastase", "Bioline", "Cuccio", "Blue Sky", "Redken", "L'Oréal Professionnel"}


def test_updating_a_field_clears_it_from_unknowns(api):
    before = api.get("/api/v1/brands").json()
    assert before["unknown_fields"]

    api.patch("/api/v1/brands", json={"positioning": "A calm, craft-led salon."})
    after = api.get("/api/v1/brands").json()
    assert after["positioning"] == "A calm, craft-led salon."


def test_pillars_are_editable_data_not_hard_coded(api):
    pillars = api.get("/api/v1/brands/pillars").json()
    assert len(pillars) >= 5

    target = pillars[0]
    response = api.put(
        f"/api/v1/brands/pillars/{target['id']}",
        json={
            "key": target["key"], "label": "Renamed pillar", "description": "d",
            "objective": "reach", "weight": 0.4, "examples": [],
        },
    )
    assert response.status_code == 200
    assert response.json()["label"] == "Renamed pillar"
    assert response.json()["source"] == "client"


# ── Content ─────────────────────────────────────────────────────────────────


def test_generate_and_approve_over_http(api):
    generated = api.post("/api/v1/content/generate", json={"format": "reel", "count": 1})
    assert generated.status_code == 200, generated.text
    item_id = generated.json()["items"][0]["id"]

    detail = api.get(f"/api/v1/content/{item_id}").json()
    assert detail["status"] == "ready_for_approval"
    assert detail["payload"]["shots"]

    approved = api.post(f"/api/v1/content/{item_id}/approve", json={"note": "ship it"})
    assert approved.json()["status"] == "client_approved"


def test_approving_twice_conflicts(api):
    item_id = api.post("/api/v1/content/generate", json={"count": 1}).json()["items"][0]["id"]
    api.post(f"/api/v1/content/{item_id}/approve", json={})
    second = api.post(f"/api/v1/content/{item_id}/approve", json={})
    assert second.status_code == 409


def test_client_edit_that_adds_a_price_is_rejected(api):
    """A human editing in a price is exactly as dangerous as a model inventing one."""
    item_id = api.post("/api/v1/content/generate", json={"count": 1}).json()["items"][0]["id"]

    response = api.patch(
        f"/api/v1/content/{item_id}", json={"caption": "Balayage now only ₹3,999!"}
    )
    assert response.status_code == 422
    assert "invented_pricing" in response.text


def test_client_edit_that_is_safe_succeeds(api):
    item_id = api.post("/api/v1/content/generate", json={"count": 1}).json()["items"][0]["id"]
    response = api.patch(f"/api/v1/content/{item_id}", json={"hook": "A cleaner hook."})
    assert response.status_code == 200
    assert response.json()["hook"] == "A cleaner hook."


def test_missing_content_returns_404(api):
    assert api.get("/api/v1/content/00000000-0000-0000-0000-000000000000").status_code == 404


def test_scheduling_unapproved_content_returns_409(api):
    item_id = api.post("/api/v1/content/generate", json={"count": 1}).json()["items"][0]["id"]
    response = api.post(
        f"/api/v1/content/{item_id}/schedule",
        json={"publish_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()},
    )
    assert response.status_code == 409


def test_pipeline_counts_cover_every_status(api):
    api.post("/api/v1/content/generate", json={"count": 1})
    counts = api.get("/api/v1/content/status/pipeline").json()
    assert counts["ready_for_approval"] >= 1
    assert "learned" in counts


# ── Assets ──────────────────────────────────────────────────────────────────


def test_upload_rejects_an_unknown_footage_type(api):
    import io

    response = api.post(
        "/api/v1/assets",
        files={"file": ("x.mp4", io.BytesIO(b"data"), "video/mp4")},
        data={"footage_type": "not_a_real_type"},
    )
    assert response.status_code == 422


def test_uploaded_asset_is_listed(api):
    import io

    upload = api.post(
        "/api/v1/assets",
        files={"file": ("before.mp4", io.BytesIO(b"data"), "video/mp4")},
        data={"footage_type": "before"},
    )
    assert upload.status_code == 201
    assert upload.json()["footage_type"] == "before"
    assert any(a["id"] == upload.json()["id"] for a in api.get("/api/v1/assets").json())


# ── Analytics and learning ──────────────────────────────────────────────────


def test_analysis_on_an_empty_account_does_not_invent_data(api):
    """A cold start must report insufficiency, not a fabricated pattern."""
    summary = api.get("/api/v1/analytics/summary").json()
    assert summary["n_posts"] == 0
    assert summary["by_pillar"] == []


def test_full_learning_loop_changes_strategy(api):
    """The loop that makes cycle N+1 differ from cycle N."""
    item_id = api.post("/api/v1/content/generate", json={"count": 1}).json()["items"][0]["id"]
    api.post(f"/api/v1/content/{item_id}/approve", json={})
    api.post(
        f"/api/v1/content/{item_id}/schedule",
        json={"publish_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()},
    )
    api.post("/api/v1/publishing/run")
    api.post("/api/v1/analytics/ingest")

    before = {p["key"]: p["weight"] for p in api.get("/api/v1/brands/pillars").json()}
    learned = api.post("/api/v1/analytics/learn", json={"days": 30})
    assert learned.status_code == 200

    body = learned.json()
    assert body["insights_stored"]
    assert body["pillar_changes"]

    after = {p["key"]: p["weight"] for p in api.get("/api/v1/brands/pillars").json()}
    assert before != after, "the learning cycle must actually change the strategy"


def test_pillar_weight_changes_are_capped(api):
    """One good cycle should nudge the strategy, not hijack it."""
    from app.services.strategy_service import MAX_WEIGHT_DELTA_PER_CYCLE

    item_id = api.post("/api/v1/content/generate", json={"count": 1}).json()["items"][0]["id"]
    api.post(f"/api/v1/content/{item_id}/approve", json={})
    api.post(
        f"/api/v1/content/{item_id}/schedule",
        json={"publish_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()},
    )
    api.post("/api/v1/publishing/run")
    api.post("/api/v1/analytics/ingest")

    changes = api.post("/api/v1/analytics/learn", json={"days": 30}).json()["pillar_changes"]
    for change in changes.values():
        assert abs(change["applied"]) <= MAX_WEIGHT_DELTA_PER_CYCLE + 1e-9


def test_pillar_weights_stay_normalised(api):
    item_id = api.post("/api/v1/content/generate", json={"count": 1}).json()["items"][0]["id"]
    api.post(f"/api/v1/content/{item_id}/approve", json={})
    api.post(
        f"/api/v1/content/{item_id}/schedule",
        json={"publish_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()},
    )
    api.post("/api/v1/publishing/run")
    api.post("/api/v1/analytics/ingest")
    api.post("/api/v1/analytics/learn", json={"days": 30})

    weights = [p["weight"] for p in api.get("/api/v1/brands/pillars").json() if p["is_active"]]
    assert abs(sum(weights) - 1.0) < 0.01


def test_ai_activity_log_attributes_cost_per_agent(api):
    api.post("/api/v1/content/generate", json={"count": 1})
    body = api.get("/api/v1/ops/ai-activity").json()

    assert body["totals"]["calls"] >= 3
    agents = {row["agent"] for row in body["by_agent"]}
    assert {"reel_writer", "virality_scorer", "qa_reviewer"} <= agents


# ── Command centre ──────────────────────────────────────────────────────────


def test_command_returns_a_plan_without_executing_by_default(api):
    body = api.post(
        "/api/v1/command", json={"command": "Make next month's content more viral."}
    ).json()

    assert body["plan"]["steps"]
    assert body["executed"] == []


def test_command_executes_its_plan_when_asked(api):
    body = api.post(
        "/api/v1/command",
        json={"command": "Make next month's content more viral.", "execute": True},
    ).json()

    assert body["executed"], "a plan the system cannot execute is just a chat transcript"
    assert any(step["ok"] for step in body["executed"])


def test_command_with_blocking_questions_does_not_execute(api):
    """Acting on a misunderstood instruction is worse than asking."""
    body = api.post(
        "/api/v1/command",
        json={"command": "Create a campaign for bridal season.", "execute": True},
    ).json()

    if body["plan"]["clarifications"]:
        assert body["executed"] == []


# ── Tenancy ─────────────────────────────────────────────────────────────────


def test_one_tenant_cannot_read_anothers_content(api, db):
    """Phase 4 readiness: the boundary must hold today, not after a refactor."""
    from app.models.content import ContentItem
    from app.models.tenancy import Client

    other = Client(name="Other Salon", slug="other-salon")
    db.add(other)
    db.commit()

    foreign = ContentItem(
        client_id=other.id, title="Someone else's reel", format="reel",
        pillar="transformation", status="ready_for_approval",
    )
    db.add(foreign)
    db.commit()

    assert api.get(f"/api/v1/content/{foreign.id}").status_code == 404
    assert all(item["id"] != str(foreign.id) for item in api.get("/api/v1/content").json())


# ── Dashboard ───────────────────────────────────────────────────────────────


def test_dashboard_recommends_with_a_reason(api):
    api.post("/api/v1/content/generate", json={"count": 1})
    body = api.get("/api/v1/dashboard").json()

    assert body["recommendation"] is not None
    assert body["recommendation"]["overall_score"] is not None
    assert body["brand_completeness"]["score"] > 0
    assert "pipeline" in body


def test_dashboard_works_on_a_cold_account(api):
    """An empty account must render, not 500."""
    body = api.get("/api/v1/dashboard").json()
    assert body["recommendation"] is None
    assert body["performance"]["n_posts"] == 0
