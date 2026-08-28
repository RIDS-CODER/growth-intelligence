# Enrose AI Social Autopilot — Architecture

> **Scope note.** This system lives entirely under `enrose/` in this repository and shares **no code,
> dependencies, runtime, or database** with the Growth Intelligence trading platform at the repo root.
> The root Node app (`server.js`, `intel/`, `index.html`, `paper.js`, root `test/`) is untouched.
> They are two independent products that happen to share a git remote.

---

## 1. The governing idea

> **Claude is the brain. The application is the body.**

Claude decides *what should happen and why*. The application does everything that must be durable,
deterministic, auditable, or transactional.

| Claude decides | The application executes |
|---|---|
| What to post, and why | Persisting every decision to PostgreSQL |
| Which strategy this cycle runs | Calendar arithmetic, slot allocation |
| Which trends fit the brand | Storage, media handling, rendering |
| Why a post over/under-performed | Instagram API calls, retries, backoff |
| What changes next cycle | Scheduling, publishing, metric collection |
| Whether a draft is good enough | Approval state machine, audit trail |

**Hard rule:** business-critical state never lives only in a model's context window. Every agent
invocation reads its inputs from PostgreSQL and writes its structured outputs back to PostgreSQL.
A model call is a pure-ish function over persisted state, and it is logged. If every LLM call vanished
tomorrow, the system's entire history — strategy, content, approvals, metrics, learned insights —
would still be intact and queryable.

## 2. The loop

The product is not a generator; it is a **closed loop** that gets better each cycle.

```
                          ┌──────────────────────────────────────────────┐
                          │                                              │
   CLIENT INPUT ─► BRAND BRAIN ─► RESEARCH ─► STRATEGY ─► CALENDAR       │
                          ▲          │           ▲           │           │
                          │          │           │           ▼           │
                    BRAND MEMORY     │      STRATEGY     CONTENT GEN     │
                          ▲          │       UPDATE          │           │
                          │          │           ▲           ▼           │
                          │     TREND DB         │      QUALITY CONTROL  │
                          │                      │           │           │
                          │                 AI PERFORMANCE    ▼           │
                          │                   ANALYSIS   CLIENT APPROVAL │
                          │                      ▲           │           │
                          │                      │           ▼           │
                    CONTENT MEMORY ◄──── ANALYTICS ◄─ SCHEDULE ─► INSTAGRAM
                          │                                              │
                          └──────────────────────────────────────────────┘
```

Two memories close the loop and are what make cycle *N+1* different from cycle *N*:

- **Content memory** — every topic, hook, format and pillar ever used, with its outcome. Prevents the
  "5 hair mistakes, again" failure mode via lexical + structural similarity checks *before* generation.
- **Brand memory** — durable learned insights ("transformation reels reach 3.1× promotional"), each with
  evidence, a confidence score, and an expiry. Injected into every downstream strategy and content prompt.

## 3. Layers

```
┌────────────────────────────────────────────────────────────────────┐
│ enrose/frontend — Next.js 15 App Router · TypeScript · Tailwind     │
│ /dashboard /calendar /content /content/[id] /assets /brand          │
│ /strategy /trends /competitors /analytics /leads /settings          │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ typed REST (src/lib/api.ts)
┌──────────────────────────────▼─────────────────────────────────────┐
│ API — FastAPI, versioned at /api/v1, tenant-scoped on every route   │
├────────────────────────────────────────────────────────────────────┤
│ SERVICES — the deterministic core. Owns state transitions,          │
│ calendar maths, approval machine, virality aggregation, memory,     │
│ safety scanning, analytics rollups. No prompt text lives here.      │
├────────────────────────────────────────────────────────────────────┤
│ AGENTS — 14 single-purpose Claude agents. Each = role + prompt      │
│ module + Pydantic output schema + validation + logging.             │
├──────────────────────┬──────────────────────┬──────────────────────┤
│ LLM PROVIDER         │ INTEGRATIONS         │ WORKERS              │
│ Anthropic │ Mock     │ Instagram: Graph|Mock│ cycle jobs, cron     │
│ (cost + token meter) │ Storage:   S3|Local  │ scheduler tick       │
├──────────────────────┴──────────────────────┴──────────────────────┤
│ PostgreSQL (SQLite for tests) — SQLAlchemy 2.0 + Alembic            │
└────────────────────────────────────────────────────────────────────┘
```

**Why services and agents are separate.** An agent proposes; a service disposes. The agent may say
"schedule this Tuesday 7pm" — the service is what validates the slot, checks it against posting
frequency policy, checks content memory for a near-duplicate, and writes the row. This split is what
lets the whole system be tested without a single network call.

## 4. Request paths

**Generation (synchronous, human-triggered)**
```
POST /api/v1/content/generate
  → ContentService loads brand brain + pillars + active strategy + content memory + insights
  → memory.check_duplicate() rejects near-duplicate topics/hooks up front (no LLM spend)
  → ReelWriter agent → validated ReelDraft schema
  → ViralityScorer agent → 12 sub-scores → deterministic weighted roll-up in services/virality.py
  → QAReviewer agent + services/safety.py rule scan (prices, medical claims, invented services)
  → status: IDEA → DRAFT → AI_REVIEW → (READY_FOR_APPROVAL | REJECTED with reasons)
  → persisted as content_items + content_variants; every agent call logged to ai_activity_log
```

**Publishing (asynchronous, scheduled)**
```
worker tick → scheduled_posts due & CLIENT_APPROVED
  → InstagramPublisher (Graph API, or MOCK when unconfigured)
  → container create → poll → publish → published_posts row
  → failures: bounded retries with backoff, error persisted, status PUBLISH_FAILED, never silent
```

**Learning (weekly)**
```
worker → AnalyticsService.rollup(30d)
  → PerformanceAnalyst agent: compares pillar/format cohorts, produces comparative findings
    ("transformation reels reached 2.4× promotional reels") — never raw metric restatement
  → LearningAgent: converts findings → brand_memory insights (evidence, confidence, expiry)
  → StrategyService applies deltas to the next cycle's pillar mix, capped and fully audited
```

## 5. Multi-tenancy (Phase 4 designed in from day one)

Every domain table carries `client_id`. Every API route resolves a `TenantContext` from the
authenticated principal and every query is filtered through it. Enrose is simply `client #1`.
There is no "single-tenant shortcut" anywhere to retrofit later — adding client #2 is a row, not a refactor.
Isolation covers: brand brain, content, assets, analytics, social accounts, AI memory, strategy, and logs.

## 6. Structured output discipline

No application logic ever branches on free-form model prose.

1. Every agent declares a Pydantic v2 output model.
2. The JSON Schema is derived from it and sent to Claude as a tool definition (forced tool use), so the
   model returns a typed object rather than prose to be regex-parsed.
3. The response is validated. On `ValidationError` the agent retries once with the validation errors fed
   back as a repair message, then fails loudly — it never coerces, never silently drops fields, and never
   falls through to a "best effort" free-text path.
4. The Mock provider satisfies the *same* schemas, so tests and offline development exercise identical
   code paths as production.

## 7. Cost control

- **Model tiering.** `settings.model_for(tier)` maps each agent to a tier. Strategy, performance analysis,
  learning and campaign planning use the strong model; captions, stories, hashtags, comment classification
  and other bounded tasks use the cheap model. Tiering is config, not code.
- **Prompt caching.** The brand brain block is large and stable, so it is emitted as a cacheable prefix
  block and reused across the many calls in a generation batch.
- **Pre-LLM filters.** Duplicate detection, safety rule scanning and calendar validity are pure Python and
  run *before* any spend.
- **Full accounting.** `ai_activity_log` records agent, task, input digest, output, input/output tokens,
  cache hits, computed USD cost, duration, and success/failure for every single call. `/api/v1/ops/ai-activity`
  exposes it, so cost is observable per agent and per content item rather than as one opaque monthly bill.

## 8. Safety architecture

Fabrication is the single biggest product risk for a real salon, so it is defended in **three independent
layers**, not one prompt instruction:

1. **Input** — the brand brain distinguishes `VERIFIED` / `REPORTED` / `INFERRED` / `UNKNOWN`. Unknown
   fields are rendered into prompts as explicit "UNKNOWN — you may not assert this" lines.
2. **Generation** — prompts forbid inventing prices, offers, results, testimonials, certifications,
   locations, and medical/clinical claims.
3. **Post-generation** — `services/safety.py` is a deterministic scanner that runs on every draft
   regardless of what the model said about itself. It flags currency amounts, discount language,
   superlatives, medical/clinical verbs, guarantee language, and any service or product name not present
   in the brand brain. Findings are blocking. **A rule violation cannot be argued away by a model.**

## 9. Technology choices and why

| Choice | Reason |
|---|---|
| FastAPI + Pydantic v2 | The same schema objects validate HTTP boundaries *and* AI output. One type system end to end. |
| SQLAlchemy 2.0 typed ORM | `Mapped[]` annotations give real static types over the schema; portable across PG and SQLite for tests. |
| PostgreSQL (JSONB) | Relational integrity for the workflow, JSONB for the naturally document-shaped AI payloads. |
| SQLite in tests | The full suite runs with no services and no network. Types are declared portably to make this safe. |
| Next.js App Router | Server components for data-heavy dashboard reads, client components only where interaction demands. |
| Provider interfaces + MOCK | Instagram and storage are behind ABCs. Missing credentials degrade to a labelled mock, never a crash and never a fake success. |

## 10. Running it

```bash
cd enrose/backend
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
cp .env.example .env                 # works unedited: SQLite + mock providers
.venv/bin/python -m app.seed.enrose  # seeds the Enrose brand brain
.venv/bin/uvicorn app.main:app --reload --port 8000

cd enrose/frontend
npm install && npm run dev           # http://localhost:3000
```

With no API keys at all the system is fully usable end to end on mock providers, and every mock response
is labelled `"provider": "MOCK"` in the API payload and badged in the UI. Nothing pretends to be real.
