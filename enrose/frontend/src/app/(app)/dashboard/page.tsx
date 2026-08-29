"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { get, post, type Dashboard } from "@/lib/api";
import {
  Bar, ContentCard, Empty, ErrorNote, Score, Section, Spinner, Stat, When,
} from "@/components/ui";

export default function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [plan, setPlan] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await get<Dashboard>("/api/v1/dashboard"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the dashboard");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function runCommand(execute: boolean) {
    if (!command.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await post<any>("/api/v1/command", { command, execute });
      setPlan(result);
      if (execute) await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Command failed");
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) return <Spinner label="Loading your account" />;
  if (!data) return <ErrorNote error={error} />;

  const greeting = new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 18 ? "Good afternoon" : "Good evening";
  const maxPillarReach = Math.max(1, ...data.performance.by_pillar.map((p) => p.avg_reach));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <p className="label">{data.client.name}</p>
        <h1 className="mt-1 font-display text-3xl text-sand">{greeting}.</h1>
      </header>

      <ErrorNote error={error} />

      {/* The single most important thing on the screen: what to post, and why. */}
      {data.recommendation ? (
        <section className="card border-rose/30 bg-gradient-to-br from-ink-900 to-ink-850">
          <p className="label">Today&apos;s recommendation</p>
          <h2 className="mt-2 font-display text-2xl text-sand">{data.recommendation.title}</h2>
          {data.recommendation.hook && (
            <p className="mt-2 text-muted">“{data.recommendation.hook}”</p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Score value={data.recommendation.viral_score} label="Viral" />
            <Score value={data.recommendation.business_score} label="Business" />
            <Score value={data.recommendation.overall_score} label="Overall" />
            <span className="chip">{data.recommendation.format}</span>
            <span className="chip">{data.recommendation.pillar.replace(/_/g, " ")}</span>
          </div>
          {data.recommendation.why && (
            <p className="mt-4 border-l-2 border-rose/40 pl-3 text-sm leading-relaxed text-muted">
              {data.recommendation.why}
            </p>
          )}
          <Link href={`/content/${data.recommendation.content_item_id}`} className="btn-primary mt-5">
            View content →
          </Link>
        </section>
      ) : (
        <Section title="No content ready yet" subtitle="Generate a strategy and your first drafts to get started.">
          <Link href="/strategy" className="btn-primary">Build this month&apos;s strategy</Link>
        </Section>
      )}

      {/* Natural-language command bar. */}
      <Section
        title="Ask the AI"
        subtitle="Tell it a goal, not a task. It plans the steps and can execute them."
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="input"
            placeholder="e.g. Create a campaign for bridal season"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runCommand(false)}
          />
          <div className="flex gap-2">
            <button onClick={() => runCommand(false)} disabled={busy} className="btn-ghost whitespace-nowrap">
              Plan
            </button>
            <button onClick={() => runCommand(true)} disabled={busy} className="btn-primary whitespace-nowrap">
              {busy ? "Working…" : "Plan & run"}
            </button>
          </div>
        </div>

        {plan && (
          <div className="mt-4 space-y-3 rounded-lg border border-ink-800 bg-ink-950/60 p-4">
            <p className="text-sm text-sand">{plan.plan.understood_intent}</p>

            {plan.plan.clarifications?.length > 0 && (
              <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
                <p className="text-xs font-medium text-amber-300">Needs an answer before running</p>
                <ul className="mt-1 list-disc pl-4 text-sm text-amber-200/80">
                  {plan.plan.clarifications.map((q: string) => <li key={q}>{q}</li>)}
                </ul>
              </div>
            )}

            <ol className="space-y-2">
              {plan.plan.steps.map((step: any) => {
                const outcome = plan.executed?.find((e: any) => e.action === step.action);
                return (
                  <li key={step.order} className="flex gap-3 text-sm">
                    <span className="mt-0.5 text-muted">{step.order}.</span>
                    <div className="min-w-0">
                      <p className="text-sand">
                        {step.action.replace(/_/g, " ")}
                        {outcome && (
                          <span className={outcome.ok ? "ml-2 text-emerald-400" : "ml-2 text-red-400"}>
                            {outcome.ok ? "done" : "failed"}
                          </span>
                        )}
                      </p>
                      <p className="text-muted">{step.rationale}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
            <p className="text-xs text-muted">{plan.plan.expected_outcome}</p>
          </div>
        )}
      </Section>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Awaiting approval" value={data.approval_queue.length} hint="Ready for your review" />
        <Stat
          label="Reels this month"
          value={data.month_production.reel ?? 0}
          hint={`${data.month_production.carousel ?? 0} carousels`}
        />
        <Stat
          label="Published posts"
          value={data.performance.n_posts}
          hint={data.performance.n_posts > 0 ? `avg reach ${Math.round(data.performance.totals.avg_reach ?? 0).toLocaleString()}` : "No data yet"}
        />
        <Stat
          label="Brand Brain"
          value={`${data.brand_completeness.score}%`}
          hint={`${data.brand_completeness.missing.length} fields still needed`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="Approval queue"
          subtitle="Highest-scoring drafts first"
          action={<Link href="/content?status=ready_for_approval" className="text-sm text-rose hover:underline">All →</Link>}
        >
          {data.approval_queue.length === 0 ? (
            <Empty>Nothing waiting. Generate content from the Content page.</Empty>
          ) : (
            <div className="space-y-3">
              {data.approval_queue.slice(0, 4).map((item) => (
                <ContentCard key={item.id} item={{ ...item, status: "ready_for_approval" }} />
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Coming up"
          subtitle="Your scheduled slots"
          action={<Link href="/calendar" className="text-sm text-rose hover:underline">Calendar →</Link>}
        >
          {[...data.today, ...data.upcoming].length === 0 ? (
            <Empty>No calendar entries. Generate a calendar from the Strategy page.</Empty>
          ) : (
            <ul className="space-y-2">
              {[...data.today, ...data.upcoming].slice(0, 6).map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-3 rounded-lg border border-ink-800 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-sand">{entry.topic ?? `${entry.format} slot`}</p>
                    <p className="text-xs text-muted"><When iso={entry.scheduled_for} /></p>
                  </div>
                  <span className="chip shrink-0">{entry.format}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {data.latest_insight && (
        <Section title="AI insight" subtitle="Learned from this account's own performance">
          <h3 className="font-display text-lg text-sand">{data.latest_insight.title}</h3>
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted">
            {data.latest_insight.body}
          </p>
          {data.latest_insight.recommendation && (
            <p className="mt-3 border-l-2 border-rose/40 pl-3 text-sm text-sand">
              {data.latest_insight.recommendation}
            </p>
          )}
          <p className="mt-3 text-xs text-muted">
            Confidence {Math.round(data.latest_insight.confidence * 100)}%
          </p>
        </Section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {data.performance.by_pillar.length > 0 && (
          <Section title="Reach by pillar" subtitle="Last 30 days">
            <div className="space-y-3">
              {data.performance.by_pillar.map((p) => (
                <div key={p.key}>
                  <div className="mb-1 flex justify-between text-sm">
                    <span className="text-sand">{p.key.replace(/_/g, " ")}</span>
                    <span className="text-muted">
                      {Math.round(p.avg_reach).toLocaleString()}
                      {!p.sufficient_data && <span className="ml-1 text-amber-400">· low n</span>}
                    </span>
                  </div>
                  <Bar value={p.avg_reach} max={maxPillarReach} />
                </div>
              ))}
            </div>
          </Section>
        )}

        {data.trend_alerts.length > 0 && (
          <Section
            title="Trend alerts"
            subtitle="Only trends that fit the brand"
            action={<Link href="/trends" className="text-sm text-rose hover:underline">All →</Link>}
          >
            <ul className="space-y-3">
              {data.trend_alerts.map((trend) => (
                <li key={trend.id} className="rounded-lg border border-ink-800 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm text-sand">{trend.name}</p>
                    <Score value={trend.relevance_score} />
                  </div>
                  {trend.recommended_adaptation && (
                    <p className="mt-1 text-xs text-muted">{trend.recommended_adaptation}</p>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>

      <Section title="Production pipeline" subtitle="Every piece of content, by stage">
        <div className="flex flex-wrap gap-2">
          {Object.entries(data.pipeline)
            .filter(([, n]) => n > 0)
            .map(([status, n]) => (
              <Link key={status} href={`/content?status=${status}`} className="chip hover:border-rose hover:text-sand">
                {status.replace(/_/g, " ")} <span className="font-semibold text-sand">{n}</span>
              </Link>
            ))}
          {Object.values(data.pipeline).every((n) => n === 0) && (
            <Empty>No content yet.</Empty>
          )}
        </div>
      </Section>
    </div>
  );
}
