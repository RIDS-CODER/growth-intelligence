# Deployment — getting Enrose AI Social live

Three ways to run this, from fastest to most permanent.

| | Time | Cost | Who it's for |
|---|---|---|---|
| **1. Local (Docker)** | ~5 min | free | See it working today |
| **2. Local (no Docker)** | ~10 min | free | Developing on it |
| **3. Cloud** | ~30 min | ~$5–25/mo + AI usage | Enrose actually using it |

Everything runs with **zero credentials** on labelled mocks. Add keys to promote each
subsystem independently — `/health` always reports which providers are real.

---

## 1. Local with Docker — fastest

One command brings up Postgres, the API and the dashboard, seeds the Brand Brain, and
runs migrations.

```bash
git clone https://github.com/RIDS-CODER/growth-intelligence.git
cd growth-intelligence
git checkout claude/enrose-social-autopilot-b5fqju
cd enrose

docker compose up --build
```

Open **http://localhost:3000** and sign in with the seeded credentials
(`owner@enrosesalon.com` / `enrose-dev-password`).

To use real Claude instead of the mock provider:

```bash
ANTHROPIC_API_KEY=sk-ant-... docker compose up --build
```

Stop with `Ctrl+C`; `docker compose down -v` also wipes the database.

## 2. Local without Docker

```bash
cd enrose/backend
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
cp .env.example .env                                  # works unedited
PYTHONPATH=. .venv/bin/python -m app.seed.enrose
PYTHONPATH=. .venv/bin/uvicorn app.main:app --reload --port 8000
```

```bash
cd enrose/frontend                                    # separate terminal
npm install && npm run dev
```

Dashboard at http://localhost:3000, API docs at http://localhost:8000/docs.

---

## 3. Cloud deployment

The split: **Vercel** hosts the dashboard, **Railway** (or Render) hosts the API and
Postgres. Both have usable free or cheap tiers.

### Step 1 — Database and API on Railway

1. Sign in at [railway.app](https://railway.app) with GitHub.
2. **New Project → Deploy from GitHub repo →** pick `growth-intelligence`.
3. In service **Settings → Root Directory**, set `enrose/backend`. Railway picks up
   `railway.json` and builds the Dockerfile.
4. **New → Database → PostgreSQL** in the same project. Railway injects `DATABASE_URL`.
5. Under **Variables**, add:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference the DB service) |
   | `SECRET_KEY` | a long random string — `openssl rand -hex 32` |
   | `APP_ENV` | `production` |
   | `ANTHROPIC_API_KEY` | your key from [console.anthropic.com](https://console.anthropic.com) |
   | `FRONTEND_ORIGINS` | your Vercel URL, e.g. `https://enrose-social.vercel.app` |
   | `SEED_ON_STARTUP` | `true` for the first deploy, then remove it |
   | `SEED_OWNER_EMAIL` | the salon's login email |
   | `SEED_OWNER_PASSWORD` | a strong password you choose |

   `SEED_OWNER_PASSWORD` is required when `APP_ENV=production` — the seed refuses to run
   with the development password.

6. Deploy, then **Settings → Networking → Generate Domain**. Check
   `https://<your-api>.up.railway.app/health` returns `"ai": "anthropic"`.

`DATABASE_URL` must use the `postgresql+psycopg://` scheme. If Railway gives you
`postgres://`, rewrite the prefix.

> Render works the same way — `enrose/backend/render.yaml` is a ready blueprint
> (**New → Blueprint**, point at the repo). It provisions the database for you.

### Step 2 — Dashboard on Vercel

1. Sign in at [vercel.com](https://vercel.com) with GitHub, **Add New → Project**, pick the repo.
2. Set **Root Directory** to `enrose/frontend`. The framework is detected automatically.
3. Add one environment variable:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_API_BASE_URL` | your Railway URL, e.g. `https://enrose-api.up.railway.app` |

4. Deploy. Vercel gives you the live URL — that is the link you share with the salon.

### Step 3 — Close the loop

Go back to Railway and set `FRONTEND_ORIGINS` to your real Vercel URL, then redeploy.
CORS is strict on purpose: it will reject the browser otherwise.

Sign in at your Vercel URL with the credentials from `SEED_OWNER_*`.

---

## What is live vs. mocked

| Subsystem | Mock until you set… | What changes |
|---|---|---|
| AI | `ANTHROPIC_API_KEY` | Real Claude writes the strategy and content instead of fixtures |
| Database | `DATABASE_URL` (postgres) | Persistent Postgres instead of a local SQLite file |
| Instagram | `META_APP_ID` + `META_APP_SECRET` | Real publishing instead of `mock_…` post ids |
| Storage | `STORAGE_PROVIDER=s3` + bucket vars | S3/R2 instead of local disk (**required** on Railway/Render — their disks are ephemeral) |
| Auth | `SUPABASE_JWT_SECRET` | Supabase Auth instead of local JWT |

The UI badges anything running on a mock, and `/health` lists the real state. Nothing
ever presents mock output as real.

### Storage matters on cloud hosts

Railway and Render containers have **ephemeral disks** — uploaded footage disappears on
redeploy. Before staff upload anything they care about, set up Cloudflare R2 (cheapest,
no egress fees) or S3:

```
STORAGE_PROVIDER=s3
STORAGE_BUCKET=enrose-media
STORAGE_ENDPOINT_URL=https://<account-id>.r2.cloudflarestorage.com
STORAGE_ACCESS_KEY_ID=...
STORAGE_SECRET_ACCESS_KEY=...
STORAGE_PUBLIC_BASE_URL=https://media.enrosesalon.com
```

### Instagram publishing — the honest timeline

This is the one part that is not instant, and it is Meta's process, not the code's:

1. A **Facebook Page** linked to an **Instagram Business or Creator** account.
2. An app at [developers.facebook.com](https://developers.facebook.com) with the
   Instagram Graph API product.
3. **App review** for `instagram_content_publish` and `instagram_manage_insights`.
   Meta review typically takes days to a couple of weeks and requires a screencast of
   the flow.

Until that clears, the mock publisher runs and everything else — strategy, generation,
approval, scheduling, the calendar — works normally. When approval lands, set
`META_APP_ID` and `META_APP_SECRET` and the same queue starts posting for real.

### Background jobs

Publishing and metric collection need a worker. Two options:

- **Simple:** set `SCHEDULER_ENABLED=true` and run a second Railway service with start
  command `python -m app.workers.scheduler` (same image, same variables).
- **Or** call `POST /api/v1/publishing/run` and `POST /api/v1/analytics/ingest` from any
  cron service (Railway cron, GitHub Actions, n8n) on a schedule.

Run the weekly learning cycle (`POST /api/v1/analytics/learn`) once a week — that is what
makes the next cycle differ from the last.

---

## Costs, realistically

| | |
|---|---|
| Vercel | Free tier is fine for one salon |
| Railway | ~$5/mo hobby, API + Postgres |
| Cloudflare R2 | ~$0.015/GB/mo, no egress fees |
| Claude API | Pay per use. A month of content (strategy + ~24 pieces + analysis) is typically a few dollars on the tiered setup — captions and stories use the cheap model, only strategy and analysis use the strong one. Track exact spend at **Settings → AI activity**, which logs every call. |

Set `AI_DAILY_COST_CAP_USD` to bound it.

---

## Before real use

- [ ] Change `SEED_OWNER_PASSWORD` from the development default
- [ ] Set a strong random `SECRET_KEY`
- [ ] Set `APP_ENV=production`
- [ ] Point `FRONTEND_ORIGINS` at the real dashboard URL only
- [ ] Move media to S3/R2 so uploads survive redeploys
- [ ] Fill the Brand Brain gaps (pricing, booking link, brand colours) — the dashboard
      shows exactly which ones and they directly limit what the AI may say
- [ ] Confirm a client-consent policy for filming faces before staff upload footage
- [ ] Keep approval at Level 1 (human approves everything) until you trust the output

## Troubleshooting

**Dashboard loads but every request fails** — `NEXT_PUBLIC_API_BASE_URL` is wrong, or
`FRONTEND_ORIGINS` on the API does not include the dashboard's exact origin. It is baked
in at build time, so change it and redeploy the frontend.

**`/health` shows `"ai": "mock"` after setting the key** — the variable did not reach the
container. Check for typos and redeploy; Railway does not hot-reload variables.

**Migrations fail on boot** — usually a `postgres://` URL. It must be
`postgresql+psycopg://`.

**Uploads vanish** — expected on ephemeral disks. Configure R2/S3.
