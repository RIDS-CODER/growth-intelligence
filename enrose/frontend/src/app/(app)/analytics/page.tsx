"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { get, post, type AnalyticsSummary } from "@/lib/api";
import { Bar, Empty, ErrorNote, Section, Spinner, Stat } from "@/components/ui";

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [analysis, setAnalysis] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await get<AnalyticsSummary>("/api/v1/analytics/summary?days=30"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analytics");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function run(path: string, label: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await post<any>(path, { days: 30 });
      if (result.analysis) setAnalysis(result.analysis);
      if (result.snapshots_written !== undefined) {
        setNote(`${result.snapshots_written} snapshots ingested from ${result.provider}`);
      }
      if (result.insights_stored) {
        setNote(`${result.insights_stored.length} insights stored · ${Object.keys(result.pillar_changes ?? {}).length} pillar weights adjusted`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return error ? <ErrorNote error={error} /> : <Spinner />;

  const maxReach = Math.max(1, ...data.by_pillar.map((p) => p.avg_reach));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <p className="label">Analytics</p>
        <h1 className="mt-1 font-display text-3xl text-sand">Last 30 days</h1>
      </header>

      <ErrorNote error={error} />
      {note && (
        <p className="rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-300">
          {note}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button onClick={() => run("/api/v1/analytics/ingest", "Ingest")} disabled={busy} className="btn-ghost">
          Refresh metrics
        </button>
        <button onClick={() => run("/api/v1/analytics/analyze", "Analysis")} disabled={busy} className="btn-primary">
          Ask AI why
        </button>
        <button onClick={() => run("/api/v1/analytics/learn", "Learning")} disabled={busy} className="btn-ghost">
          Run learning cycle
        </button>
      </div>

      {data.n_posts === 0 ? (
        <Empty>
          No published posts yet. Approve, schedule and publish content, then refresh metrics —
          the analyst will not invent a pattern from nothing.
        </Empty>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Posts" value={data.n_posts} />
            <Stat label="Total reach" value={(data.totals.total_reach ?? 0).toLocaleString()} />
            <Stat label="Avg reach" value={Math.round(data.totals.avg_reach ?? 0).toLocaleString()} />
            <Stat
              label="Avg engagement"
              value={`${((data.totals.avg_engagement_rate ?? 0) * 100).toFixed(1)}%`}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="By pillar">
              <div className="space-y-3">
                {data.by_pillar.map((cohort) => (
                  <div key={cohort.key}>
                    <div className="mb-1 flex justify-between text-sm">
                      <span className="text-sand">{cohort.key.replace(/_/g, " ")}</span>
                      <span className="text-muted">
                        {Math.round(cohort.avg_reach).toLocaleString()}
                        <span className="ml-1 text-xs">n={cohort.n}</span>
                      </span>
                    </div>
                    <Bar value={cohort.avg_reach} max={maxReach} />
                    {!cohort.sufficient_data && (
                      <p className="mt-0.5 text-xs text-amber-400">
                        Too few posts to draw a conclusion.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </Section>

            <Section title="Top performers">
              {data.top_posts.length === 0 ? <Empty>No data.</Empty> : (
                <ul className="space-y-2">
                  {data.top_posts.map((post) => (
                    <li key={post.content_item_id}>
                      <Link href={`/content/${post.content_item_id}`}
                            className="flex items-center justify-between gap-3 rounded-lg border border-ink-800 px-3 py-2 text-sm hover:border-ink-600">
                        <span className="truncate text-sand">{post.title}</span>
                        <span className="shrink-0 text-muted">{post.reach.toLocaleString()}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </>
      )}

      {analysis && (
        <Section
          title="AI performance analysis"
          subtitle={`Data sufficiency: ${analysis.data_sufficiency}`}
        >
          <p className="mb-4 rounded-lg border border-rose/30 bg-ink-950/60 p-3 text-sm text-sand">
            {analysis.headline_recommendation}
          </p>

          <div className="space-y-4">
            {analysis.findings.map((finding: any) => (
              <div key={finding.headline} className="rounded-lg border border-ink-800 p-3">
                <p className="font-medium text-sand">{finding.headline}</p>
                <p className="mt-1 text-sm text-rose-soft">{finding.comparison}</p>
                <p className="mt-2 label">Why</p>
                <ul className="mt-1 list-disc pl-5 text-sm text-muted">
                  {finding.why.map((reason: string) => <li key={reason}>{reason}</li>)}
                </ul>
                <p className="mt-2 text-xs text-muted">
                  Confidence {Math.round(finding.confidence * 100)}% · {finding.magnitude}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {[
              ["Do more of", analysis.do_more_of, "text-emerald-300"],
              ["Do less of", analysis.do_less_of, "text-amber-300"],
              ["Stop doing", analysis.stop_doing, "text-red-300"],
            ].map(([title, items, tone]) => (
              <div key={title as string}>
                <p className={`label ${tone as string}`}>{title as string}</p>
                <ul className="mt-1.5 list-disc pl-4 text-sm text-muted">
                  {(items as string[]).map((entry) => <li key={entry}>{entry}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      )}

      {data.insights.length > 0 && (
        <Section title="Learned insights" subtitle="Injected into every future content decision">
          <div className="space-y-3">
            {data.insights.map((insight) => (
              <div key={insight.id} className="rounded-lg border border-ink-800 p-3">
                <p className="font-medium text-sand">{insight.title}</p>
                <p className="mt-1 whitespace-pre-line text-sm text-muted">{insight.body}</p>
                {insight.recommendation && (
                  <p className="mt-2 border-l-2 border-rose/40 pl-3 text-sm text-sand">
                    {insight.recommendation}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
