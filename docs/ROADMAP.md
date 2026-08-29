# Roadmap

## Phase 1 — MVP (delivered in this change)

Fully usable with **zero credentials**: SQLite + mock AI + mock Instagram + local storage.
Every mock is labelled `MOCK` in API responses and badged in the UI.

| # | Capability | Status |
|---|---|---|
| 1 | Authentication (JWT, Supabase-compatible) | ✅ |
| 2 | Enrose Brand Brain (seeded from verified research, `UNKNOWN`-aware) | ✅ |
| 3 | Content database (full schema, 30 tables) | ✅ |
| 4 | AI strategy agent | ✅ |
| 5 | Content planner / calendar generation | ✅ |
| 6 | Reel generator | ✅ |
| 7 | Carousel generator | ✅ |
| 8 | Caption generator | ✅ |
| 9 | Approval dashboard + status machine | ✅ |
| 10 | Content calendar (month grid, reschedule) | ✅ |
| 11 | Asset upload + raw-footage analysis + capture checklist | ✅ |
| 12 | Basic analytics (ingest, rollup, cohorts) | ✅ |
| 13 | AI performance analysis + learning loop | ✅ |
| + | Virality engine, QA agent, content memory, command center, AI activity log | ✅ |

**Deliberately not done in Phase 1:** real Instagram publishing (needs Meta app review), live trend
scraping, video rendering. Their interfaces exist with mock implementations behind them, so Phase 2 is
swapping an implementation, not writing a layer.

## Phase 2 — Connected

- **Instagram OAuth** — Meta app, Business/Creator account, `instagram_content_publish` +
  `instagram_manage_insights` scopes. Requires Meta app review; token refresh and encryption at rest
  already scaffolded in `social_accounts`.
- **Real publishing** — swap `InstagramMock` for `InstagramGraphAPI` (already written against the real
  container→publish flow). Worker, retries, and error persistence are done.
- **Scheduling at scale** — move the in-process scheduler to a real queue (RQ/Celery + Redis) or n8n;
  the job functions are already pure and queue-agnostic.
- **Live trend research** — the trend agent currently reasons from brand + seasonal context. Add real
  sources (Meta insights, audio trend feeds where licensing permits) behind a `TrendSource` interface.
- **Competitor monitoring** — public-data collection within Instagram's ToS; `competitor_posts` is ready.
- **Video assembly** — FFmpeg cut-list execution from `FootageAnalysis.sequence` (which already emits real
  cut points), Remotion for templated overlays and covers.
- **Story automation** — story publishing where API support permits.

## Phase 3 — Conversational & revenue

- Comment classification and suggested replies; complaints never auto-answered.
- DM classification, intent extraction, high-intent lead alerts to staff.
- Lead pipeline: profile visit → DM → WhatsApp → booking, with attribution back to the content item, so
  the analyst can rank content by *bookings* rather than views.
- Booking-system and WhatsApp Business integration.
- Automated campaign creation from a single natural-language goal.

## Phase 4 — Agency platform

Tenancy is already enforced on every table and query. Remaining work is product, not architecture:
client onboarding wizard, cross-client console, per-client cost caps and billing, white-labelling,
role-based permissions per client, and a benchmark layer that learns across clients without leaking
any client's data into another's context.

## Known limitations, stated plainly

- **No live Enrose Instagram data.** The site and the Instagram profile are blocked by this environment's
  egress proxy, so no follower count, cadence, or historical engagement is known. All of it is `UNKNOWN`
  in the Brand Brain and the analytics engine starts from an honest cold start. See `docs/BRAND_RESEARCH.md`.
- **The mock AI provider is deterministic, not intelligent.** It returns schema-valid, brand-aware fixtures
  so the whole loop is testable offline. Real creative quality requires `ANTHROPIC_API_KEY`.
- **No prices anywhere.** None were published. Adding them is a client action in the Brand Brain UI.
- **Learning needs volume.** Insight confidence is gated on sample size; with fewer than 8 posts in a
  cohort the analyst reports low confidence rather than inventing a pattern.
