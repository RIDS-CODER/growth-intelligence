# Enrose AI Social Autopilot

An AI Social Media Manager / Creative Director / Content Operations Engine for
**Enrose Salon** (Bistupur, Jamshedpur).

> **This is a separate product.** It shares a git repository with the Growth Intelligence
> trading platform at the repo root and *nothing else* — no code, no dependencies, no runtime,
> no database, no build. The root Node app (`server.js`, `intel/`, `index.html`, `paper.js`,
> root `test/`, root `package.json`) is untouched by this subtree.

---

## Run it in two minutes

No API keys required. With none configured the system runs end to end on SQLite plus
clearly-labelled mock providers.

```bash
# Backend
cd enrose/backend
python -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env                          # works unedited
PYTHONPATH=. .venv/bin/python -m app.seed.enrose
PYTHONPATH=. .venv/bin/uvicorn app.main:app --reload --port 8000

# Frontend (separate terminal)
cd enrose/frontend
npm install
npm run dev                                   # http://localhost:3000
```

Sign in with the seeded development credentials shown by the seed script
(`owner@enrosesalon.com`). **Change them before any real deployment.**

## Verify it actually works

```bash
cd enrose/backend
PYTHONPATH=. .venv/bin/python -m pytest tests -q      # 151 tests
PYTHONPATH=. .venv/bin/python scripts/e2e_check.py    # 30 acceptance checks
```

`e2e_check.py` walks all fifteen Phase 1 success criteria against the real application:
log in → open Enrose → read the Brand Brain → generate a strategy → generate a calendar →
generate reels and carousels → generate captions → upload footage → analyse it → attach it →
review → approve/reject → schedule → publish → ingest metrics → ask the AI why → read the
recommendations for the next cycle.

## What it does

| | |
|---|---|
| **Understands the brand** | A Brand Brain with per-field provenance (`verified` / `reported` / `inferred` / `unknown`) and a completeness score that names the gaps limiting content quality |
| **Plans** | Strategy agent sets pillar mix, posting frequency, format split and objectives, optimising for bookings rather than views |
| **Schedules** | Deterministic calendar allocation with drag-and-drop rescheduling |
| **Creates** | Reels with hooks, shot lists, on-screen text, editing instructions and b-roll; carousels with real template keys; stories; three caption lengths |
| **Scores** | 12 model-scored dimensions rolled up in deterministic Python into viral / business / overall scores that stay comparable over time |
| **Checks** | A deterministic rule scanner plus a QA agent. The scanner is authoritative — a model cannot approve away a rule violation |
| **Turns footage into content** | Staff upload clips from real appointments; the system picks the reel, sequences the cuts, and reports **what they failed to film and why it matters** |
| **Tells staff what to shoot** | A weekly capture checklist — about 75 minutes of filming yields roughly 12 content items |
| **Publishes** | Instagram Graph API (container → poll → publish), with a labelled mock when credentials are absent. No browser automation, ever |
| **Learns** | Analytics → comparative causal analysis → durable insights with confidence and expiry → capped strategy deltas → next cycle |
| **Remembers** | Content memory kills near-duplicate topics *before* any spend; brand memory feeds learned insights into every prompt |

## Layout

```
enrose/
├── backend/
│   ├── app/
│   │   ├── agents/         14 Claude agents over a shared runtime
│   │   ├── prompts/        modular prompts; one shared safety preamble
│   │   ├── llm/            Anthropic + deterministic Mock provider, cost metering
│   │   ├── models/         SQLAlchemy 2.0 — 33 tables, tenant-scoped
│   │   ├── schemas/        Pydantic contracts for AI output and HTTP
│   │   ├── services/       the deterministic core (status machine, safety,
│   │   │                   virality, memory, calendar, approval, learning)
│   │   ├── integrations/   Instagram + storage, each real | mock
│   │   ├── api/v1/         54 endpoints
│   │   ├── workers/        publish / ingest / weekly learning jobs
│   │   └── seed/           Enrose Brand Brain from verified research only
│   ├── alembic/            initial migration (applies and rolls back cleanly)
│   ├── scripts/            e2e_check.py
│   └── tests/              151 tests, no network, no credentials
└── frontend/               Next.js 15 · TypeScript · Tailwind — 15 routes
```

Design docs live at the repo root: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md),
[`docs/PRODUCT_SPEC.md`](../docs/PRODUCT_SPEC.md), [`docs/AI_AGENTS.md`](../docs/AI_AGENTS.md),
[`docs/DATABASE.md`](../docs/DATABASE.md), [`docs/ROADMAP.md`](../docs/ROADMAP.md),
[`docs/BRAND_RESEARCH.md`](../docs/BRAND_RESEARCH.md).

## Going live

Each subsystem promotes independently by adding credentials to `.env`:

| Set | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Real Claude instead of the mock provider |
| `DATABASE_URL` (postgres) | PostgreSQL with JSONB; run `alembic upgrade head` |
| `META_APP_ID` + `META_APP_SECRET` | Real Instagram publishing (needs Meta app review) |
| `STORAGE_PROVIDER=s3` + bucket | S3 / Cloudflare R2 instead of local disk |
| `SUPABASE_JWT_SECRET` | Supabase Auth instead of local JWT |

`/health` always reports which providers are actually live, and the UI badges anything
running on a mock.

## Safety

Fabrication is the biggest risk in shipping AI content for a real salon, so it is defended
in three independent layers: brand-brain confidence labels → prompt constraints →
a deterministic post-generation scanner whose findings are blocking and cannot be overridden.

The system never invents prices, offers, services, results, testimonials, medical claims,
certifications, locations, staff names or local events. **No price is recorded for Enrose
because none is published anywhere** — every service reads `price UNKNOWN`, and the Brand
Brain UI shows that as a gap for the client to fill rather than a hole for a model to fill.

`docs/BRAND_RESEARCH.md` records exactly what was verified, what was merely reported, and
what could not be reached from this environment — including all Instagram metrics, which are
`UNKNOWN` and are never asserted.
