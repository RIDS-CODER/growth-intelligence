"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/** Score pill. Colour encodes the band, so a weak score is visible at a glance. */
export function Score({ value, label }: { value: number | null | undefined; label?: string }) {
  if (value === null || value === undefined) {
    return <span className="chip">{label ? `${label} —` : "—"}</span>;
  }
  const tone =
    value >= 80 ? "border-emerald-800 text-emerald-300"
    : value >= 65 ? "border-amber-800 text-amber-300"
    : "border-red-900 text-red-300";
  return (
    <span className={`chip ${tone}`}>
      {label && <span className="text-muted">{label}</span>}
      <span className="font-semibold">{Math.round(value)}</span>
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  idea: "border-ink-700 text-muted",
  draft: "border-ink-700 text-muted",
  ai_review: "border-sky-900 text-sky-300",
  ready_for_approval: "border-amber-800 text-amber-300",
  revision_requested: "border-orange-900 text-orange-300",
  rejected: "border-red-900 text-red-300",
  client_approved: "border-emerald-900 text-emerald-300",
  scheduled: "border-indigo-900 text-indigo-300",
  published: "border-emerald-800 text-emerald-200",
  publish_failed: "border-red-900 text-red-300",
  analyzing: "border-sky-900 text-sky-300",
  learned: "border-violet-900 text-violet-300",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`chip ${STATUS_TONE[status] ?? "border-ink-700 text-muted"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

/**
 * Marks anything produced by a mock provider. The product's honesty rule: a mock
 * result is never presented as if it were real.
 */
export function MockBadge({ show = true }: { show?: boolean }) {
  if (!show) return null;
  return (
    <span className="chip border-amber-800/70 text-amber-300" title="No credentials configured — this used a mock provider.">
      MOCK
    </span>
  );
}

/** Confidence badge for a Brand Brain fact. */
export function Confidence({ level }: { level: string }) {
  const tone: Record<string, string> = {
    verified: "border-emerald-900 text-emerald-300",
    reported: "border-sky-900 text-sky-300",
    inferred: "border-amber-900 text-amber-300",
    unknown: "border-red-900 text-red-300",
  };
  return <span className={`chip ${tone[level] ?? "border-ink-700 text-muted"}`}>{level}</span>;
}

export function Section({
  title, subtitle, action, children,
}: {
  title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="card">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-lg text-sand">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-ink-700 px-4 py-6 text-center text-sm text-muted">
      {children}
    </p>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="mb-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-300">
      {error}
    </p>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-ink-700 border-t-rose" />
      {label}…
    </div>
  );
}

/** Horizontal proportion bar — used for pillar mixes and cohort comparisons. */
export function Bar({ value, max, tone = "bg-rose" }: { value: number; max: number; tone?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="card">
      <p className="label">{label}</p>
      <p className="mt-1 font-display text-2xl text-sand">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function ContentCard({ item }: { item: { id: string; title: string; format: string; pillar: string; hook: string | null; overall_score: number | null; status?: string } }) {
  return (
    <Link href={`/content/${item.id}`} className="card card-hover block">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-sand">{item.title}</p>
          {item.hook && <p className="mt-1 line-clamp-2 text-sm text-muted">“{item.hook}”</p>}
        </div>
        <Score value={item.overall_score} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="chip">{item.format}</span>
        <span className="chip">{item.pillar.replace(/_/g, " ")}</span>
        {item.status && <StatusBadge status={item.status} />}
      </div>
    </Link>
  );
}

/** Formats an ISO timestamp consistently on server and client to avoid hydration drift. */
export function useFormattedDate(iso: string | null | undefined, opts?: Intl.DateTimeFormatOptions) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!iso) return setText("—");
    setText(
      new Date(iso).toLocaleString(undefined, opts ?? {
        weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      }),
    );
  }, [iso, opts]);
  return text;
}

export function When({ iso }: { iso: string | null | undefined }) {
  return <>{useFormattedDate(iso)}</>;
}
