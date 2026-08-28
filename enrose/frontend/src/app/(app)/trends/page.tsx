"use client";

import { useCallback, useEffect, useState } from "react";

import { get, post, type Trend } from "@/lib/api";
import { Empty, ErrorNote, Score, Section, Spinner } from "@/components/ui";

export default function TrendsPage() {
  const [trends, setTrends] = useState<Trend[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTrends(await get<Trend[]>("/api/v1/trends"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load trends");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function research() {
    setBusy(true);
    try {
      await post("/api/v1/trends/research", {});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trend research failed");
    } finally {
      setBusy(false);
    }
  }

  const fits = (trends ?? []).filter((t) => t.fits_brand);
  const rejected = (trends ?? []).filter((t) => t.fits_brand === false);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label">Trends</p>
          <h1 className="mt-1 font-display text-3xl text-sand">Trend intelligence</h1>
          <p className="mt-1 text-sm text-muted">
            A trend is only useful if it fits the brand. The rejections matter as much as the adoptions.
          </p>
        </div>
        <button onClick={research} disabled={busy} className="btn-primary">
          {busy ? "Researching…" : "Research trends"}
        </button>
      </header>

      <ErrorNote error={error} />

      {!trends ? <Spinner /> : trends.length === 0 ? (
        <Empty>No trends detected yet. Run trend research to populate this.</Empty>
      ) : (
        <>
          <Section title="Worth adopting" subtitle={`${fits.length} trends fit the brand`}>
            {fits.length === 0 ? <Empty>None yet.</Empty> : (
              <div className="space-y-3">
                {fits.map((trend) => (
                  <div key={trend.id} className="rounded-lg border border-ink-800 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-sand">{trend.name}</p>
                        <p className="mt-0.5 text-sm text-muted">{trend.description}</p>
                      </div>
                      <Score value={trend.relevance_score} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span className="chip">{trend.category}</span>
                      {trend.popularity && <span className="chip">{trend.popularity}</span>}
                      {trend.expiry_probability !== null && (
                        <span className="chip">
                          {Math.round(trend.expiry_probability * 100)}% expiry risk
                        </span>
                      )}
                    </div>
                    {trend.recommended_adaptation && (
                      <p className="mt-2 border-l-2 border-rose/40 pl-3 text-sm text-sand">
                        {trend.recommended_adaptation}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>

          {rejected.length > 0 && (
            <Section
              title="Deliberately rejected"
              subtitle="Kept on record so the same bad idea is not proposed again"
            >
              <div className="space-y-3">
                {rejected.map((trend) => (
                  <div key={trend.id} className="rounded-lg border border-red-900/40 bg-red-950/10 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-medium text-sand">{trend.name}</p>
                      <span className="chip border-red-900 text-red-300">rejected</span>
                    </div>
                    {trend.fit_reason && (
                      <p className="mt-1.5 text-sm text-red-200/70">{trend.fit_reason}</p>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
