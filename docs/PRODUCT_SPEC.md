# Product Spec — Enrose AI Social Autopilot

## The product in one line

Not "make me 20 posts". The instruction the system is built to accept is:

> **"Grow Enrose's Instagram and generate more salon bookings."**

…and the system decides what to post, when, why, how to produce it, which trends to use, what to keep,
what to stop, what to film, what to measure, what it learned, and what to do next.

## Who uses it

| Role | Does |
|---|---|
| **Salon owner / client** | Reviews the approval queue, approves or requests revisions, reads insights, sets goals in natural language |
| **Salon staff** | Reads the weekly Content Capture Checklist, films it, uploads raw footage |
| **Agency operator (Phase 4)** | Runs many clients from one console |
| **The system** | Everything else |

## Core surfaces

### `/dashboard`
Answers "what do I do today?" in one screen: today's recommendation with viral + business scores and a
stated *why*; approval queue depth; this month's production counts; top performers; the newest AI insight;
trend alerts; lead alerts; production pipeline by status.

### `/brand` — Brand Brain
Every field the AI reasons from, client-editable: description, tone, audience, services, products,
locations, colours, fonts, visual style, words to avoid, claims to avoid, competitors, pillars, goals.
Uploads: logo, brand guidelines, imagery, video.

Each field shows its **confidence badge** (`VERIFIED` / `REPORTED` / `INFERRED` / `UNKNOWN`) and the page
shows a **completeness score** with the specific gaps that are currently limiting content quality. Filling
a gap visibly unlocks capability — that is the incentive design.

### `/strategy`
The active cycle strategy: pillar mix with weights, posting frequency, format split, objectives, audience
segments, and the rationale. Shows which learned insights produced the current weighting and the delta
from last cycle, so strategy change is legible rather than mysterious.

### `/calendar`
Month grid, drag-and-drop rescheduling, filters by format/pillar/status. Each entry shows format, pillar,
hook, status, and approval state.

### `/content` and `/content/[id]`
Pipeline list by status. The detail page is the editor: preview, edit caption / hook / CTA, swap media,
see the shot list or slide structure, read the QA report and the 12 virality sub-scores with reasoning,
then approve / reject / request revision / schedule.

### `/assets`
Upload raw footage, tag it by footage type, run footage analysis, attach to content. Shows the
**missing-shot report** and the weekly capture checklist.

### `/analytics`
Metrics over time by pillar and format, cohort comparisons, top and bottom performers, and — the point —
the AI's causal read on *why*, not a wall of numbers.

### `/trends`, `/competitors`, `/leads`, `/settings`
Trend database with relevance and expiry; competitor tracking and gap analysis; lead pipeline with intent
scores; connections, approval level, model tiers, cost caps.

## Content engines

**Reels** — concept, hook, first 1–3 seconds, full script, numbered shot list, on-screen text, voiceover,
editing instructions, b-roll requirements, CTA, caption, hashtags, cover text, objective, both scores.

**Carousels** — cover + 4–9 slides, each with headline, body, visual instruction and a real template key;
CTA slide; caption. Renderable through reusable templates.

**Stories** — daily sequences across 11 categories, bound to the day's feed post.

**Raw footage** — staff upload what they actually shot; the system decides which reel to build from it,
in what order, with what cuts and overlays, and reports what is missing and what to shoot next time.

**Capture mode** — a weekly per-day checklist telling staff exactly what to film. The design goal is to
turn 1–2 hours of staff filming into weeks of raw material, which is what makes the whole loop survive
contact with a busy salon.

## Virality Engine

12 model-scored dimensions, deterministic Python roll-up:

```
Viral Score:    82/100   ← hook, curiosity, emotion, shareability, saveability,
                            rewatch, relatability, trend alignment
Business Score: 91/100   ← audience relevance, brand fit, conversion potential,
                            visual transformation
Overall:        87/100   ← configurable blend (default 50/50)
```

Every score carries a written reason, the single biggest weakness, and a concrete fix. Scores are
comparable over time precisely because the arithmetic is not in the model.

## Approval model

| Level | Flow | Applies to |
|---|---|---|
| **1** | AI generates → human approves → publish | Default for everything |
| **2** | AI generates → auto-publish | Low-risk only: no claims, no offers, QA clean, score above threshold |
| **3** | Mandatory human approval, no exceptions | Campaigns, offers, prices, any factual claim |

Level 2 is **off by default**. Auto-publishing is opt-in per client, and the eligibility rules live in
`services/approval.py` where they are tested, not in a prompt.

## Safety contract

Never fabricated, under any circumstances:

> prices · offers · packages · services not in the brand brain · results or outcomes · testimonials ·
> reviews · medical or clinical claims · product claims · certifications · awards · locations · staff names ·
> local events

Unavailable information is marked `UNKNOWN` and the system says so rather than filling the hole.
Enforced in three independent layers (brand-brain confidence → prompt constraints → deterministic
post-generation scanner). The scanner is authoritative: a model cannot talk its way past a rule violation.

## Phases

**Phase 1 (built here)** — auth · Enrose Brand Brain · content database · strategy agent · planner ·
reel/carousel/caption generators · virality engine · QA · approval dashboard · calendar · asset upload ·
raw-footage analysis · capture checklist · analytics ingest · AI performance analysis · learning loop ·
command center · AI activity log. Fully usable on mock providers with zero credentials.

**Phase 2** — Instagram OAuth, real scheduling and auto-publishing, live trend research, competitor
monitoring, video assembly (FFmpeg/Remotion), story automation.

**Phase 3** — comment AI, DM AI, lead classification, booking and WhatsApp integration, automated
campaigns, advanced analytics.

**Phase 4** — multi-client agency platform. The tenancy model is already in place.

## Phase 1 acceptance criteria

Each maps to a verified endpoint or page; `enrose/backend/scripts/e2e_check.py` exercises the whole list
against a running server.

1. Log into the dashboard → `POST /api/v1/auth/login`
2. Open Enrose → `GET /api/v1/clients`
3. View its Brand Brain → `GET /api/v1/brands/{id}`
4. Ask AI for next month's strategy → `POST /api/v1/strategy/generate`
5. Generate a content calendar → `POST /api/v1/calendar/generate`
6. Generate individual reels → `POST /api/v1/content/generate` (`format=reel`)
7. Generate carousels → `POST /api/v1/content/generate` (`format=carousel`)
8. Generate captions → `POST /api/v1/content/{id}/captions`
9. Upload raw salon footage → `POST /api/v1/assets`
10. Attach footage to content → `POST /api/v1/content/{id}/assets`
11. Review content → `GET /api/v1/content/{id}`
12. Approve / reject → `POST /api/v1/content/{id}/approve` · `/reject`
13. View performance → `GET /api/v1/analytics/summary`
14. Ask AI why content performed → `POST /api/v1/analytics/analyze`
15. See recommendations for the next cycle → `GET /api/v1/insights`

## Explicit non-goals

- No browser automation or scraping of Instagram. Official Graph API only. When credentials are absent the
  publisher is a **labelled** mock that returns mock IDs — it never reports a fake success as real.
- No generic caption-generator mode. Content is always produced inside a strategy with an objective.
- No fake UI. Every button in the dashboard calls a real endpoint. Anything not yet connected is either
  absent or badged `MOCK`.
