/**
 * Typed client for the autopilot API.
 *
 * Every call goes to a real endpoint. There are no stubbed responses here — if a
 * subsystem is running on a mock provider the API says so in its payload
 * (`is_mock`, `provider`) and the UI badges it.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

const TOKEN_KEY = "enrose_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, detail: unknown, message: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function describe(detail: unknown, fallback: string): string {
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (Array.isArray(record.rejected) && record.rejected.length > 0) {
      const first = record.rejected[0] as Record<string, unknown>;
      return String(first.reason ?? fallback);
    }
    if (Array.isArray(detail) && detail.length > 0) {
      const first = detail[0] as Record<string, unknown>;
      if (typeof first.msg === "string") return first.msg;
    }
  }
  return fallback;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: "no-store" });

  if (response.status === 401 && typeof window !== "undefined") {
    clearToken();
    window.location.href = "/login";
    throw new ApiError(401, null, "Session expired");
  }

  if (!response.ok) {
    let detail: unknown = null;
    try {
      detail = (await response.json())?.detail ?? null;
    } catch {
      detail = await response.text().catch(() => null);
    }
    throw new ApiError(response.status, detail, describe(detail, `Request failed (${response.status})`));
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const put = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const del = <T,>(path: string) => api<T>(path, { method: "DELETE" });

export async function upload<T>(path: string, form: FormData): Promise<T> {
  return api<T>(path, { method: "POST", body: form });
}

// ── Types mirroring the API's response models ──────────────────────────────

export type ContentStatus =
  | "idea" | "draft" | "ai_review" | "ready_for_approval" | "revision_requested"
  | "rejected" | "client_approved" | "scheduled" | "published" | "publish_failed"
  | "analyzing" | "learned";

export interface ContentItem {
  id: string;
  title: string;
  format: string;
  pillar: string;
  objective: string | null;
  status: ContentStatus;
  hook: string | null;
  viral_score: number | null;
  business_score: number | null;
  overall_score: number | null;
  scheduled_for: string | null;
  published_at: string | null;
  created_at: string;
}

export interface ContentDetail extends ContentItem {
  caption: string | null;
  cta: string | null;
  hashtags: string[];
  payload: Record<string, any>;
  score_breakdown: Record<string, any>;
  qa_report: Record<string, any>;
  approval_level: string;
}

export interface CalendarEntry {
  id: string;
  content_item_id: string | null;
  scheduled_for: string;
  slot_label: string | null;
  format: string;
  pillar: string;
  topic: string | null;
  status: string;
  position: number;
}

export interface Pillar {
  id: string;
  key: string;
  label: string;
  description: string | null;
  objective: string | null;
  weight: number;
  examples: string[];
  source: string;
  is_active: boolean;
}

export interface BrandBrain {
  id: string;
  name: string;
  website: string | null;
  instagram_handle: string | null;
  description: string | null;
  positioning: string | null;
  tone: Record<string, any>;
  visual_identity: Record<string, any>;
  locations: Record<string, any>[];
  business_goals: Record<string, any>[];
  words_to_avoid: string[];
  claims_to_avoid: string[];
  unknown_fields: string[];
  provenance: Record<string, string>;
  completeness: number;
  missing_fields: string[];
  services: { id: string; name: string; category: string; price: number | null; confidence: string }[];
  products: { id: string; brand_name: string; category: string | null; confidence: string }[];
  audiences: {
    id: string; segment: string; pains: string[]; desires: string[];
    priority: number; confidence: string; demographics: Record<string, string>;
  }[];
  pillars: Pillar[];
  competitors: { id: string; name: string; handle: string | null; tier: string; notes: string | null }[];
}

export interface Strategy {
  id: string;
  title: string;
  period_start: string;
  period_end: string;
  pillar_mix: Record<string, number>;
  posting_frequency: Record<string, number>;
  format_split: Record<string, number>;
  objectives: { objective: string; target: string; why: string }[];
  audience_focus: string[];
  themes: string[];
  rationale: string | null;
  status: string;
  created_at: string;
}

export interface Insight {
  id: string;
  title: string;
  body: string;
  kind: string;
  confidence: number;
  recommendation: string | null;
  created_at: string;
}

export interface Trend {
  id: string;
  name: string;
  category: string;
  description: string | null;
  popularity: string | null;
  relevance_score: number;
  expiry_probability: number | null;
  fits_brand: boolean | null;
  fit_reason: string | null;
  recommended_adaptation: string | null;
  status: string;
  detected_on: string;
}

export interface Asset {
  id: string;
  filename: string;
  kind: string;
  storage_key: string;
  mime_type: string | null;
  size_bytes: number | null;
  duration_s: number | null;
  footage_type: string;
  tags: string[];
  notes: string | null;
  shoot_group: string | null;
  provider: string;
  created_at: string;
}

export interface Dashboard {
  client: { id: string; name: string };
  recommendation: {
    content_item_id: string; title: string; format: string; pillar: string;
    hook: string | null; viral_score: number | null; business_score: number | null;
    overall_score: number | null; why: string | null;
  } | null;
  today: CalendarEntry[];
  upcoming: CalendarEntry[];
  approval_queue: { id: string; title: string; format: string; pillar: string; overall_score: number | null; hook: string | null }[];
  month_production: Record<string, number>;
  pipeline: Record<string, number>;
  latest_insight: { id: string; title: string; body: string; recommendation: string | null; confidence: number } | null;
  trend_alerts: { id: string; name: string; relevance_score: number; recommended_adaptation: string | null }[];
  lead_alerts: { id: string; handle: string | null; intent: string; requested_service: string | null; message: string | null }[];
  performance: {
    n_posts: number;
    totals: Record<string, number>;
    top_posts: { content_item_id: string; title: string; pillar: string; format: string; reach: number; saves: number }[];
    by_pillar: { key: string; n: number; avg_reach: number; avg_saves: number; sufficient_data: boolean }[];
  };
  brand_completeness: { score: number; missing: string[] };
}

export interface AnalyticsSummary {
  by_pillar: { key: string; n: number; avg_reach: number; avg_engagement_rate: number; avg_saves: number; avg_profile_visits: number; sufficient_data: boolean }[];
  by_format: { key: string; n: number; avg_reach: number; avg_engagement_rate: number; avg_saves: number; avg_profile_visits: number; sufficient_data: boolean }[];
  totals: Record<string, number>;
  top_posts: { content_item_id: string; title: string; pillar: string; format: string; reach: number; saves: number; profile_visits: number }[];
  bottom_posts: { content_item_id: string; title: string; reach: number }[];
  n_posts: number;
  period_days: number;
  insights: Insight[];
}

export interface AIActivity {
  entries: {
    id: string; agent: string; task: string; model: string | null; provider: string;
    input_tokens: number; output_tokens: number; cost_usd: number; duration_ms: number;
    success: boolean; error: string | null; created_at: string;
  }[];
  totals: { calls: number; cost_usd: number; input_tokens: number; output_tokens: number };
  by_agent: { agent: string; calls: number; cost_usd: number }[];
}

export interface Health {
  status: string;
  version: string;
  environment: string;
  providers: { ai: string; instagram: string; storage: string; auth: string };
  models: Record<string, string>;
}
