"use client";

import { useCallback, useEffect, useState } from "react";

import { get, post } from "@/lib/api";
import { Empty, ErrorNote, Section, Spinner } from "@/components/ui";

interface Competitor {
  id: string;
  name: string;
  handle: string | null;
  tier: string;
  notes: string | null;
  last_analyzed_at: string | null;
}

export default function CompetitorsPage() {
  const [competitors, setCompetitors] = useState<Competitor[] | null>(null);
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setCompetitors(await get<Competitor[]>("/api/v1/brands/competitors"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load competitors");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function analyse() {
    setBusy(true);
    setError(null);
    try {
      const result = await post<any>("/api/v1/competitors/analyze", {});
      setReport(result.report);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label">Competitors</p>
          <h1 className="mt-1 font-display text-3xl text-sand">Competitive gaps</h1>
          <p className="mt-1 text-sm text-muted">
            The point is not to copy them — it is to find what they are leaving open.
          </p>
        </div>
        <button onClick={analyse} disabled={busy} className="btn-primary">
          {busy ? "Analysing…" : "Analyse competitors"}
        </button>
      </header>

      <ErrorNote error={error} />

      <Section title="Tracked competitors">
        {!competitors ? <Spinner /> : competitors.length === 0 ? (
          <Empty>No competitors tracked.</Empty>
        ) : (
          <ul className="space-y-2">
            {competitors.map((competitor) => (
              <li key={competitor.id} className="rounded-lg border border-ink-800 p-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium text-sand">{competitor.name}</p>
                  <span className="chip">{competitor.tier}</span>
                </div>
                {competitor.notes && <p className="mt-1 text-sm text-muted">{competitor.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {report && (
        <>
          <Section title="Openings to exploit" subtitle="What the competitive set is not covering">
            <ul className="space-y-2">
              {report.exploitable_gaps.map((gap: string) => (
                <li key={gap} className="flex gap-2 text-sm">
                  <span className="text-rose">→</span>
                  <span className="text-sand">{gap}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Differentiation strategy">
            <p className="text-sm leading-relaxed text-muted">{report.differentiation_strategy}</p>
          </Section>

          {report.do_not_copy?.length > 0 && (
            <Section title="Do not copy" subtitle="Behaviours to deliberately avoid">
              <ul className="space-y-1.5">
                {report.do_not_copy.map((entry: string) => (
                  <li key={entry} className="flex gap-2 text-sm text-red-200/80">
                    <span className="text-red-400">✕</span>
                    {entry}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {report.profiles?.length > 0 && (
            <Section title="Profiles">
              <div className="grid gap-3 md:grid-cols-2">
                {report.profiles.map((profile: any) => (
                  <div key={profile.name} className="rounded-lg border border-ink-800 p-3">
                    <p className="font-medium text-sand">{profile.name}</p>
                    <p className="mt-1 text-xs text-muted">Cadence: {profile.posting_frequency}</p>
                    <p className="mt-1 text-xs text-muted">Hooks: {profile.hook_style}</p>
                    <p className="mt-1 text-xs text-muted">Visuals: {profile.visual_style}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {profile.dominant_formats?.map((format: string) => (
                        <span key={format} className="chip">{format}</span>
                      ))}
                      <span className="chip">engagement: {profile.engagement_signal}</span>
                    </div>
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
