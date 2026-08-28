"""End-to-end check of every Phase 1 success criterion.

Runs the fifteen acceptance criteria from `docs/PRODUCT_SPEC.md` against the real
application through FastAPI's TestClient — real routes, real services, real
database, mock AI and mock Instagram.

Run with:  python scripts/e2e_check.py
Exits non-zero if any criterion fails.
"""

from __future__ import annotations

import io
import sys
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.db import SessionLocal, create_all
from app.main import app
from app.seed.enrose import DEFAULT_EMAIL, DEFAULT_PASSWORD, seed

PASS, FAIL = "PASS", "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> bool:
    results.append((PASS if condition else FAIL, name, detail))
    print(f"  [{PASS if condition else FAIL}] {name}" + (f" — {detail}" if detail else ""))
    return condition


def main() -> int:
    create_all()
    with SessionLocal() as db:
        seed(db)

    client = TestClient(app)
    print("\nEnrose AI Social Autopilot — Phase 1 acceptance check\n" + "=" * 60)

    health = client.get("/health").json()
    print(f"  providers: {health['providers']}\n")

    # 1. Log in
    login = client.post(
        "/api/v1/auth/login", json={"email": DEFAULT_EMAIL, "password": DEFAULT_PASSWORD}
    )
    if not check("1. Log into the dashboard", login.status_code == 200, f"HTTP {login.status_code}"):
        return 1
    token = login.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # 2. Open Enrose
    clients = client.get("/api/v1/clients", headers=headers)
    check(
        "2. Open Enrose",
        clients.status_code == 200 and clients.json()[0]["slug"] == "enrose",
        clients.json()[0]["name"] if clients.status_code == 200 else "",
    )

    # 3. Brand Brain
    brand = client.get("/api/v1/brands", headers=headers)
    bj = brand.json() if brand.status_code == 200 else {}
    check(
        "3. View its Brand Brain",
        brand.status_code == 200 and len(bj.get("services", [])) >= 20,
        f"{len(bj.get('services', []))} services, {len(bj.get('products', []))} products, "
        f"{bj.get('completeness')}% complete, {len(bj.get('unknown_fields', []))} unknowns",
    )
    check(
        "3b. No fabricated prices in the Brand Brain",
        all(s.get("price") is None for s in bj.get("services", [])),
        "every service price is UNKNOWN, as published",
    )

    # 4. Strategy
    strategy = client.post(
        "/api/v1/strategy/generate", headers=headers, json={"period_days": 30, "refresh_brand": True}
    )
    sj = strategy.json().get("strategy", {}) if strategy.status_code == 200 else {}
    check(
        "4. Ask AI to create next month's strategy",
        strategy.status_code == 200 and bool(sj.get("pillar_mix")),
        f"{len(sj.get('pillar_mix', {}))} pillars, split {sj.get('format_split')}",
    )

    # 5. Calendar
    calendar = client.post("/api/v1/calendar/generate", headers=headers, json={"days": 30})
    cj = calendar.json() if calendar.status_code == 200 else {}
    check(
        "5. Generate a content calendar",
        calendar.status_code == 200 and len(cj.get("entries", [])) > 0,
        f"{len(cj.get('entries', []))} slots: {cj.get('counts')}",
    )

    # 6. Reels
    reels = client.post(
        "/api/v1/content/generate", headers=headers, json={"format": "reel", "count": 3}
    )
    rj = reels.json() if reels.status_code == 200 else {}
    reel_items = rj.get("items", [])
    check(
        "6. Generate individual Reels",
        reels.status_code == 200 and len(reel_items) >= 1,
        f"{len(reel_items)} created, {len(rj.get('rejected', []))} rejected by QA",
    )
    if reel_items:
        detail = client.get(f"/api/v1/content/{reel_items[0]['id']}", headers=headers).json()
        check(
            "6b. Reel has a full production package",
            bool(detail["payload"].get("shots")) and bool(detail["payload"].get("editing_instructions")),
            f"{len(detail['payload'].get('shots', []))} shots, hook: \"{detail['hook'][:48]}…\"",
        )
        check(
            "6c. Reel is scored on both axes",
            detail["viral_score"] is not None and detail["business_score"] is not None,
            f"viral {detail['viral_score']}, business {detail['business_score']}, "
            f"overall {detail['overall_score']}",
        )

    # 7. Carousels
    carousels = client.post(
        "/api/v1/content/generate", headers=headers, json={"format": "carousel", "count": 1}
    )
    cjs = carousels.json() if carousels.status_code == 200 else {}
    carousel_items = cjs.get("items", [])
    check(
        "7. Generate carousels",
        carousels.status_code == 200 and len(carousel_items) >= 1,
        f"{len(carousel_items)} created",
    )

    if not reel_items:
        print("\nNo reel generated; cannot continue.")
        return 1
    item_id = reel_items[0]["id"]

    # 8. Captions
    captions = client.post(f"/api/v1/content/{item_id}/captions", headers=headers)
    kj = captions.json() if captions.status_code == 200 else {}
    check(
        "8. Generate captions",
        captions.status_code == 200 and len(kj.get("variants", [])) >= 2,
        f"{len(kj.get('variants', []))} caption variants",
    )

    # 9. Upload footage
    uploaded: list[str] = []
    for footage_type in ("before", "color", "styling", "after"):
        response = client.post(
            "/api/v1/assets",
            headers=headers,
            files={"file": (f"{footage_type}.mp4", io.BytesIO(b"fake video bytes"), "video/mp4")},
            data={"footage_type": footage_type, "shoot_group": "e2e-shoot"},
        )
        if response.status_code == 201:
            uploaded.append(response.json()["id"])
    check("9. Upload raw salon footage", len(uploaded) == 4, f"{len(uploaded)} clips uploaded")

    footage = client.post(
        "/api/v1/assets/analyze", headers=headers, json={"shoot_group": "e2e-shoot"}
    )
    fj = footage.json().get("analysis", {}) if footage.status_code == 200 else {}
    check(
        "9b. Footage analysis reports missing shots",
        footage.status_code == 200 and len(fj.get("missing_shots", [])) > 0,
        f"verdict '{fj.get('verdict')}', {len(fj.get('missing_shots', []))} missing: "
        + ", ".join(m["shot"] for m in fj.get("missing_shots", [])[:2]),
    )

    checklist = client.post("/api/v1/assets/capture-checklist", headers=headers)
    chj = checklist.json().get("checklist", {}) if checklist.status_code == 200 else {}
    check(
        "9c. Weekly capture checklist for staff",
        checklist.status_code == 200 and len(chj.get("days", [])) >= 5,
        f"{len(chj.get('days', []))} days, ~{chj.get('total_estimated_minutes')} min filming",
    )

    # 10. Attach footage
    attach = client.post(
        f"/api/v1/content/{item_id}/assets", headers=headers, json={"asset_ids": uploaded}
    )
    check(
        "10. Attach footage to content",
        attach.status_code == 200 and len(attach.json().get("attached", [])) == 4,
        f"{len(attach.json().get('attached', []))} clips attached",
    )

    # 11. Review
    review = client.get(f"/api/v1/content/{item_id}", headers=headers)
    check(
        "11. Review content",
        review.status_code == 200 and bool(review.json().get("qa_report")),
        f"status '{review.json().get('status')}', QA checks: "
        f"{len(review.json().get('qa_report', {}).get('checks', []))}",
    )

    # 12. Approve / reject
    approve = client.post(f"/api/v1/content/{item_id}/approve", headers=headers, json={"note": "ok"})
    check(
        "12. Approve content",
        approve.status_code == 200 and approve.json()["status"] == "client_approved",
        f"status '{approve.json().get('status')}'",
    )
    if len(reel_items) > 1:
        reject = client.post(
            f"/api/v1/content/{reel_items[1]['id']}/reject", headers=headers, json={"note": "no"}
        )
        check(
            "12b. Reject content",
            reject.status_code == 200 and reject.json()["status"] == "rejected",
            f"status '{reject.json().get('status')}'",
        )

    # Schedule and publish so there is something to analyse.
    publish_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    scheduled = client.post(
        f"/api/v1/content/{item_id}/schedule",
        headers=headers,
        json={"publish_at": publish_at.isoformat()},
    )
    check(
        "12c. Schedule approved content",
        scheduled.status_code == 200,
        f"provider '{scheduled.json().get('provider')}' (mock: {scheduled.json().get('is_mock')})",
    )

    published = client.post("/api/v1/publishing/run", headers=headers)
    check(
        "12d. Publish (labelled MOCK without Meta credentials)",
        published.status_code == 200 and published.json().get("published", 0) >= 1,
        f"{published.json().get('published')} published via '{published.json().get('provider')}'",
    )

    ingest = client.post("/api/v1/analytics/ingest", headers=headers)
    check(
        "13a. Ingest metrics",
        ingest.status_code == 200 and ingest.json().get("snapshots_written", 0) >= 1,
        f"{ingest.json().get('snapshots_written')} snapshots from '{ingest.json().get('provider')}'",
    )

    # 13. View performance
    summary = client.get("/api/v1/analytics/summary", headers=headers)
    smj = summary.json() if summary.status_code == 200 else {}
    check(
        "13. View performance",
        summary.status_code == 200 and smj.get("n_posts", 0) >= 1,
        f"{smj.get('n_posts')} posts, avg reach {smj.get('totals', {}).get('avg_reach')}",
    )

    # 14. Ask why
    analyze = client.post("/api/v1/analytics/analyze", headers=headers, json={"days": 30})
    aj = analyze.json().get("analysis", {}) if analyze.status_code == 200 else {}
    findings = aj.get("findings", [])
    check(
        "14. Ask AI why content performed well/poorly",
        analyze.status_code == 200 and len(findings) >= 1,
        f"{len(findings)} findings; first: \"{findings[0]['comparison'][:70]}…\"" if findings else "",
    )
    check(
        "14b. Findings are comparative, not raw metric restatements",
        all(f.get("comparison") and f.get("why") for f in findings),
        "every finding carries a comparison and a mechanism",
    )

    # 15. Recommendations for next cycle
    learn = client.post("/api/v1/analytics/learn", headers=headers, json={"days": 30})
    lj = learn.json() if learn.status_code == 200 else {}
    check(
        "15. Learning loop updates strategy",
        learn.status_code == 200 and len(lj.get("insights_stored", [])) >= 1,
        f"{len(lj.get('insights_stored', []))} insights stored, "
        f"{len(lj.get('pillar_changes', {}))} pillar weights adjusted",
    )
    insights = client.get("/api/v1/insights", headers=headers)
    check(
        "15b. See AI recommendations for the next cycle",
        insights.status_code == 200 and len(insights.json()) >= 1,
        f"{len(insights.json())} active insights",
    )

    # Extras that make it feel like a hire rather than a tool.
    dashboard = client.get("/api/v1/dashboard", headers=headers)
    dj = dashboard.json() if dashboard.status_code == 200 else {}
    check(
        "16. Dashboard recommends what to post today, with a reason",
        dashboard.status_code == 200 and dj.get("recommendation") is not None,
        f"\"{dj.get('recommendation', {}).get('title')}\" "
        f"(overall {dj.get('recommendation', {}).get('overall_score')})",
    )

    command = client.post(
        "/api/v1/command",
        headers=headers,
        json={"command": "Make next month's content more viral.", "execute": False},
    )
    pj = command.json().get("plan", {}) if command.status_code == 200 else {}
    check(
        "17. Natural-language command produces an executable plan",
        command.status_code == 200 and len(pj.get("steps", [])) >= 2,
        f"{len(pj.get('steps', []))} steps: "
        + " → ".join(s["action"] for s in pj.get("steps", [])[:4]),
    )

    activity = client.get("/api/v1/ops/ai-activity", headers=headers)
    act = activity.json() if activity.status_code == 200 else {}
    check(
        "18. Every AI call is logged with cost",
        activity.status_code == 200 and act.get("totals", {}).get("calls", 0) > 0,
        f"{act.get('totals', {}).get('calls')} calls across "
        f"{len(act.get('by_agent', []))} agents, ${act.get('totals', {}).get('cost_usd')}",
    )

    trends = client.post("/api/v1/trends/research", headers=headers)
    tj = trends.json() if trends.status_code == 200 else {}
    check(
        "19. Trend research rejects trends that do not fit the brand",
        trends.status_code == 200 and tj.get("rejected", 0) > 0,
        f"{tj.get('adopted')} adopted, {tj.get('rejected')} explicitly rejected",
    )

    failed = [r for r in results if r[0] == FAIL]
    print("\n" + "=" * 60)
    print(f"  {len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("\n  Failures:")
        for _, name, detail in failed:
            print(f"    - {name} {detail}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
