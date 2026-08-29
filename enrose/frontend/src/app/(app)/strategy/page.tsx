"use client";

import { useCallback, useEffect, useState } from "react";

import { get, post, type Strategy } from "@/lib/api";
import { Bar, Empty, ErrorNote, Section, Spinner } from "@/components/ui";

export default function StrategyPage() {
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [emphasis, setEmphasis] = useState("");

  const load = useCallback(async () => {
    try {
      setStrategy(await get<Strategy | null>("/api/v1/strategy/active"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the strategy");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function generate() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await post<any>("/api/v1/strategy/generate", {
        period_days: 30,
        emphasis: emphasis || undefined,
        refresh_brand: false,
      });
      setNote(`New strategy created · $${result.cost_usd.toFixed(4)}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Strategy generation failed");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <Spinner />;

  const maxWeight = Math.max(0.01, ...Object.values(strategy?.pillar_mix ?? { x: 0.01 }));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <p className="label">Strategy</p>
        <h1 className="mt-1 font-display text-3xl text-sand">
          {strategy ? strategy.title : "No active strategy"}
        </h1>
        {strategy && (
          <p className="mt-1 text-sm text-muted">
            {strategy.period_start} → {strategy.period_end}
          </p>
        )}
      </header>

      <ErrorNote error={error} />
      {note && (
        <p className="rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-300">
          {note}
        </p>
      )}

      <Section
        title="Plan the next cycle"
        subtitle="The strategist weighs business value, audience relevance, past performance, trends and brand fit."
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="input"
            placeholder="Optional emphasis, e.g. bridal season, monsoon haircare"
            value={emphasis}
            onChange={(e) => setEmphasis(e.target.value)}
          />
          <button onClick={generate} disabled={busy} className="btn-primary whitespace-nowrap">
            {busy ? "Planning…" : "Generate strategy"}
          </button>
        </div>
      </Section>

      {!strategy ? (
        <Empty>No strategy yet. Generate one to drive the calendar and content engine.</Empty>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="Pillar mix" subtitle="What share of output each pillar gets">
              <div className="space-y-3">
                {Object.entries(strategy.pillar_mix)
                  .sort(([, a], [, b]) => b - a)
                  .map(([key, weight]) => (
                    <div key={key}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span className="text-sand">{key.replace(/_/g, " ")}</span>
                        <span className="text-muted">{Math.round(weight * 100)}%</span>
                      </div>
                      <Bar value={weight} max={maxWeight} />
                    </div>
                  ))}
              </div>
            </Section>

            <Section title="Output plan" subtitle="This cycle's volume">
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(strategy.format_split)
                  .filter(([, n]) => n > 0)
                  .map(([format, n]) => (
                    <div key={format} className="rounded-lg border border-ink-800 p-3">
                      <p className="font-display text-2xl text-sand">{n}</p>
                      <p className="label mt-0.5">{format}s</p>
                    </div>
                  ))}
              </div>
              <div className="mt-4">
                <p className="label">Posting frequency</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {Object.entries(strategy.posting_frequency).map(([key, value]) => (
                    <span key={key} className="chip">{key.replace(/_/g, " ")}: {value}</span>
                  ))}
                </div>
              </div>
            </Section>
          </div>

          <Section title="Objectives" subtitle="Bookings, not just views">
            <ul className="space-y-3">
              {strategy.objectives.map((objective) => (
                <li key={objective.objective} className="rounded-lg border border-ink-800 p-3">
                  <div className="flex items-baseline gap-2">
                    <span className="chip border-rose/50 text-rose-soft">
                      {objective.objective.replace(/_/g, " ")}
                    </span>
                    <p className="text-sm text-sand">{objective.target}</p>
                  </div>
                  <p className="mt-1.5 text-sm text-muted">{objective.why}</p>
                </li>
              ))}
            </ul>
          </Section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="Themes">
              <div className="flex flex-wrap gap-2">
                {strategy.themes.map((theme) => <span key={theme} className="chip">{theme}</span>)}
              </div>
            </Section>
            <Section title="Audience focus">
              <div className="flex flex-wrap gap-2">
                {strategy.audience_focus.map((audience) => (
                  <span key={audience} className="chip">{audience}</span>
                ))}
              </div>
            </Section>
          </div>

          {strategy.rationale && (
            <Section title="Why this plan" subtitle="The strategist's reasoning">
              <p className="whitespace-pre-line text-sm leading-relaxed text-muted">
                {strategy.rationale}
              </p>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
