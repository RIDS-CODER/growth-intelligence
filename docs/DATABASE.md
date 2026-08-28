# Database Design

PostgreSQL 15+ in production (JSONB, GIN indexes). SQLite in tests — column types are declared portably
(`JSONType`, `sqlalchemy.Uuid`) so the identical models run on both and the suite needs no services.

Defined in `enrose/backend/app/models/`, migrated by Alembic (`alembic/versions/0001_initial.py`).

## Conventions

- Primary keys: UUID (`sqlalchemy.Uuid`, `default=uuid4`).
- Every domain table carries `client_id` → `clients.id`, indexed. This is the tenancy boundary and it is
  present from day one so Phase 4 is a row, not a rewrite.
- `created_at` / `updated_at` on every table (UTC, server-defaulted).
- Enums are Python `str, Enum` persisted as text — readable in `psql`, and adding a value is not a migration hazard.
- Loose or model-shaped payloads go in JSONB columns; anything the app filters, joins or sorts on is a real column.

## Entity map

```
users ──┬── memberships ──┐
        │                 ▼
        └──────────► clients ──► brands ──┬── brand_assets
                        │                 ├── services
                        │                 ├── products
                        │                 ├── audiences
                        │                 ├── competitors ──► competitor_posts
                        │                 ├── content_pillars
                        │                 └── brand_memory
                        │
                        ├── strategies ──► campaigns ──► content_items
                        │                                    │
                        │   content_ideas ───────────────────┤
                        │                                    ├── content_variants
                        │                                    ├── content_assets ──► assets
                        │                                    ├── approvals
                        │                                    ├── calendar_entries
                        │                                    ├── scheduled_posts ──► published_posts
                        │                                    │                          │
                        │                                    └── content_memory         ▼
                        │                                                        analytics_snapshots
                        ├── social_accounts                                             │
                        ├── trends                                                      ▼
                        ├── ai_insights ◄──────────────────────────────────────── (performance analysis)
                        ├── leads ──► comments, dm_threads
                        └── ai_activity_log, audit_logs
```

## Tables

### Tenancy
| Table | Purpose | Key columns |
|---|---|---|
| `users` | Auth principals. Supabase-compatible: `supabase_uid` links to an external IdP, `password_hash` supports local dev. | `email` (uniq), `supabase_uid` (uniq), `role`, `is_active` |
| `clients` | A tenant. Enrose is client #1. | `name`, `slug` (uniq), `timezone`, `status` |
| `memberships` | user × client × role. | uniq(`user_id`,`client_id`) |

### Brand Brain
| Table | Purpose | Notable |
|---|---|---|
| `brands` | The Brand Brain core. | `positioning`, `tone` (JSONB), `visual_identity` (JSONB), `words_to_avoid[]`, `claims_to_avoid[]`, `business_goals` (JSONB), `locations` (JSONB), `unknown_fields[]`, `completeness` |
| `brand_assets` | Logo, guidelines, imagery, video. | `kind`, `storage_key`, `mime_type`, `meta` |
| `services` | Real services only. | `name`, `category`, `description`, `price` **nullable — null means UNKNOWN, never guessed**, `is_verified` |
| `products` | Kérastase, Bioline, Cuccio, Blue Sky, Redken, L'Oréal Professionnel. | `brand_name`, `is_verified` |
| `audiences` | Segments. | `segment`, `demographics` (JSONB), `pains`, `desires`, `confidence` |
| `competitors` | Monitored set. | `handle`, `tier`, `is_active` |
| `content_pillars` | **Not hard-coded** — discovered and reweighted by agents. | `key`, `weight`, `objective`, `is_active`, `source` (`seed`\|`ai_discovered`\|`client`) |
| `brand_memory` | Durable learned insights. | `insight`, `evidence` (JSONB), `confidence`, `expires_at`, `superseded_by` |

`services.price` being nullable is a deliberate safety design: there is no sentinel a model could
mistake for a real number, and the prompt renderer emits `price: UNKNOWN` for nulls.

### Strategy & planning
| Table | Purpose |
|---|---|
| `strategies` | One per cycle. `period_start/end`, `pillar_mix` (JSONB), `posting_frequency` (JSONB), `objectives`, `format_split`, `rationale`, `status`, `derived_from_insights[]` |
| `campaigns` | Bridal season, festive, launches. `goal`, `start/end`, `status` |
| `calendar_entries` | Scheduled slot: `scheduled_for`, `slot_label`, `format`, `pillar`, `status`, `position` (drag-and-drop ordering) |

### Content
| Table | Purpose |
|---|---|
| `content_ideas` | Pre-production backlog with scores; promotable to a `content_item` |
| `content_items` | The spine. `format`, `pillar`, `objective`, `status`, `hook`, `caption`, `cta`, `payload` (JSONB: shot lists, slides), `viral_score`, `business_score`, `overall_score`, `qa_report` (JSONB), `approval_level`, `scheduled_for` |
| `content_variants` | Alternative captions/hooks/covers, with `is_selected` |
| `content_assets` | content_item × asset join, with `role` (b-roll, cover, hero) and `position` |
| `assets` | Uploaded media. `storage_key`, `kind`, `duration_s`, `tags[]`, `footage_type`, `analysis` (JSONB) |
| `content_memory` | Anti-repetition index: `topic`, `hook`, `topic_fingerprint`, `hook_fingerprint`, `pillar`, `format`, `outcome`, `performance_index` |

`content_memory` fingerprints are normalised token sets. `services/memory.py` does Jaccard similarity
against them *before* any generation call — cheap, deterministic, and it kills the
"5 hair mistakes / 5 haircare mistakes / 5 mistakes with your hair" failure mode before it costs a token.

### Publishing
| Table | Purpose |
|---|---|
| `social_accounts` | OAuth connection. `platform`, `handle`, `ig_user_id`, `access_token` (encrypted at rest), `token_expires_at`, `is_mock` |
| `scheduled_posts` | Publish queue. `publish_at`, `status`, `attempts`, `last_error`, `provider` |
| `published_posts` | Result. `platform_post_id`, `permalink`, `published_at` |

### Analytics & learning
| Table | Purpose |
|---|---|
| `analytics_snapshots` | Time series per post: reach, impressions, views, likes, comments, shares, saves, follows, profile_visits, link_clicks, engagement_rate, `captured_at`. Append-only — a snapshot is never mutated, so growth curves stay reconstructable. |
| `ai_insights` | Analyst output: `title`, `body`, `kind`, `evidence` (JSONB), `confidence`, `recommendation`, `applied_at` |

### Engagement (Phase 3 schema, present now)
`leads` (`source`, `intent`, `score`, `status`, `contact`) · `comments` (`classification`, `suggested_reply`,
`requires_human`) · `dm_threads` (`intent`, `lead_id`, `escalated`).

### Ops
| Table | Purpose |
|---|---|
| `ai_activity_log` | Every model call: `agent`, `task`, `input_digest`, `output` (JSONB), `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cost_usd`, `duration_ms`, `success`, `error`, `content_item_id` |
| `audit_logs` | Who/what changed state: `actor_type` (user\|agent\|system), `action`, `entity`, `before`/`after` (JSONB) |

## Indexes

- `client_id` on every domain table.
- `content_items`: (`client_id`,`status`), (`client_id`,`scheduled_for`), (`client_id`,`pillar`).
- `analytics_snapshots`: (`content_item_id`,`captured_at`), (`client_id`,`captured_at`).
- `content_memory`: (`client_id`,`topic_fingerprint`), (`client_id`,`pillar`).
- `scheduled_posts`: (`status`,`publish_at`) — the worker's hot path.
- `ai_activity_log`: (`client_id`,`created_at`), (`agent`,`created_at`).

## Content status machine

```
IDEA → DRAFT → AI_REVIEW → READY_FOR_APPROVAL → CLIENT_APPROVED → SCHEDULED → PUBLISHED → ANALYZING → LEARNED
                    │              │
                    └─► REJECTED   └─► REVISION_REQUESTED ─► DRAFT
```

Transitions are enforced centrally in `services/content_status.py` by an explicit allowed-transitions map.
Nothing writes `content_items.status` directly — an illegal jump (e.g. `DRAFT → PUBLISHED`) raises
`InvalidTransition` and is covered by tests. Every transition writes an `audit_logs` row.
