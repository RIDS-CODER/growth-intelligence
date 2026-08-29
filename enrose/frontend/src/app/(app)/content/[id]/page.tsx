"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { get, patch, post, type Asset, type ContentDetail } from "@/lib/api";
import {
  Bar, Empty, ErrorNote, Score, Section, Spinner, StatusBadge, When,
} from "@/components/ui";

export default function ContentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [item, setItem] = useState<ContentDetail | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ hook: string; caption: string; cta: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const detail = await get<ContentDetail>(`/api/v1/content/${id}`);
      setItem(detail);
      setEdit({ hook: detail.hook ?? "", caption: detail.caption ?? "", cta: detail.cta ?? "" });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load content");
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { get<Asset[]>("/api/v1/assets").then(setAssets).catch(() => setAssets([])); }, []);

  async function act(action: string, body?: unknown) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await post(`/api/v1/content/${id}/${action}`, body ?? {});
      setNote(`${action.replace(/-/g, " ")} succeeded`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!edit) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await patch(`/api/v1/content/${id}`, edit);
      setNote("Saved. Your edit passed the safety scan.");
      await load();
    } catch (err) {
      // A rejected edit is a feature: the scanner catches a human-typed price too.
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function schedule() {
    const when = new Date(Date.now() + 24 * 3600 * 1000);
    setBusy(true);
    try {
      await post(`/api/v1/content/${id}/schedule`, { publish_at: when.toISOString() });
      setNote(`Scheduled for ${when.toLocaleString()}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scheduling failed");
    } finally {
      setBusy(false);
    }
  }

  async function attach(assetId: string) {
    setBusy(true);
    try {
      await post(`/api/v1/content/${id}/assets`, { asset_ids: [assetId], role: "broll" });
      setNote("Footage attached");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Attach failed");
    } finally {
      setBusy(false);
    }
  }

  if (!item) return error ? <ErrorNote error={error} /> : <Spinner />;

  const dims: Record<string, { score: number; reason: string }> =
    item.score_breakdown?.dimensions ?? {};
  const qaChecks: { check: string; passed: boolean; severity: string; detail: string }[] =
    item.qa_report?.checks ?? [];
  const blocking: string[] = item.qa_report?.blocking_reasons ?? [];
  const shots = item.payload?.shots ?? [];
  const slides = item.payload?.slides ?? [];

  const canApprove = item.status === "ready_for_approval";
  const canSchedule = item.status === "client_approved";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link href="/content" className="text-sm text-muted hover:text-sand">← All content</Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={item.status} />
            <span className="chip">{item.format}</span>
            <span className="chip">{item.pillar.replace(/_/g, " ")}</span>
            {item.objective && <span className="chip">{item.objective.replace(/_/g, " ")}</span>}
          </div>
          <h1 className="mt-3 font-display text-3xl text-sand">{item.title}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Score value={item.viral_score} label="Viral" />
          <Score value={item.business_score} label="Business" />
          <Score value={item.overall_score} label="Overall" />
        </div>
      </header>

      <ErrorNote error={error} />
      {note && (
        <p className="rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-300">
          {note}
        </p>
      )}

      {/* Decisions come first: this is what the client is here to do. */}
      <Section title="Decision" subtitle={canApprove ? "This draft passed quality control and is ready for you." : `Current status: ${item.status.replace(/_/g, " ")}`}>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => act("approve")} disabled={busy || !canApprove} className="btn-primary">
            Approve
          </button>
          <button onClick={() => act("request-revision")} disabled={busy || !canApprove} className="btn-ghost">
            Request revision
          </button>
          <button onClick={() => act("reject")} disabled={busy || !canApprove} className="btn-danger">
            Reject
          </button>
          <button onClick={schedule} disabled={busy || !canSchedule} className="btn-ghost">
            Schedule for tomorrow
          </button>
          <button onClick={() => act("captions")} disabled={busy} className="btn-ghost">
            Regenerate captions
          </button>
        </div>
        {item.scheduled_for && (
          <p className="mt-3 text-sm text-muted">Scheduled for <When iso={item.scheduled_for} /></p>
        )}
      </Section>

      <Section title="Edit" subtitle="Your edits are re-scanned — a typed-in price is caught the same as a generated one.">
        {edit && (
          <div className="space-y-4">
            <div>
              <label className="label" htmlFor="hook">Hook</label>
              <input id="hook" className="input mt-1.5" value={edit.hook}
                     onChange={(e) => setEdit({ ...edit, hook: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="caption">Caption</label>
              <textarea id="caption" rows={7} className="input mt-1.5 font-mono text-xs leading-relaxed"
                        value={edit.caption} onChange={(e) => setEdit({ ...edit, caption: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="cta">Call to action</label>
              <input id="cta" className="input mt-1.5" value={edit.cta}
                     onChange={(e) => setEdit({ ...edit, cta: e.target.value })} />
            </div>
            <button onClick={save} disabled={busy} className="btn-primary">Save changes</button>
          </div>
        )}
      </Section>

      {shots.length > 0 && (
        <Section title="Shot list" subtitle={`${item.payload.estimated_duration_s}s · filmable during a normal appointment`}>
          <div className="mb-4 rounded-lg border border-rose/30 bg-ink-950/60 p-4">
            <p className="label">First three seconds</p>
            <p className="mt-1 text-sm text-sand">{item.payload.first_three_seconds}</p>
          </div>
          <ol className="space-y-3">
            {shots.map((shot: any) => (
              <li key={shot.index} className="rounded-lg border border-ink-800 p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-medium text-sand">Shot {shot.index} — {shot.description}</p>
                  <span className="chip shrink-0">{shot.duration_s}s</span>
                </div>
                <p className="mt-1 text-xs text-muted">Camera: {shot.camera}</p>
                {shot.on_screen_text && (
                  <p className="mt-1 text-xs text-rose-soft">On screen: “{shot.on_screen_text}”</p>
                )}
              </li>
            ))}
          </ol>
          {item.payload.editing_instructions?.length > 0 && (
            <div className="mt-4">
              <p className="label">Editing instructions</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                {item.payload.editing_instructions.map((line: string) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          )}
        </Section>
      )}

      {slides.length > 0 && (
        <Section title="Slides" subtitle={`${slides.length} slides`}>
          <ol className="space-y-3">
            {slides.map((slide: any) => (
              <li key={slide.index} className="rounded-lg border border-ink-800 p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-medium text-sand">{slide.index}. {slide.headline}</p>
                  <span className="chip shrink-0">{slide.template_key}</span>
                </div>
                {slide.body && <p className="mt-1 text-sm text-muted">{slide.body}</p>}
                <p className="mt-1 text-xs text-muted/70">Visual: {slide.visual_instruction}</p>
              </li>
            ))}
          </ol>
        </Section>
      )}

      <Section title="Why this score" subtitle="Twelve dimensions, scored and reasoned">
        {Object.keys(dims).length === 0 ? (
          <Empty>Not scored.</Empty>
        ) : (
          <div className="space-y-3">
            {Object.entries(dims).map(([key, dim]) => (
              <div key={key}>
                <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-sand">{key.replace(/_/g, " ")}</span>
                  <span className="text-muted">{Math.round(dim.score)}</span>
                </div>
                <Bar value={dim.score} max={100} tone={dim.score >= 75 ? "bg-emerald-500" : dim.score >= 55 ? "bg-amber-500" : "bg-red-500"} />
                <p className="mt-1 text-xs text-muted">{dim.reason}</p>
              </div>
            ))}
            {item.score_breakdown?.biggest_weakness && (
              <div className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
                <p className="text-xs font-medium text-amber-300">Biggest weakness</p>
                <p className="mt-1 text-sm text-amber-200/80">{item.score_breakdown.biggest_weakness}</p>
                <p className="mt-2 text-xs font-medium text-amber-300">Fix</p>
                <p className="mt-1 text-sm text-amber-200/80">{item.score_breakdown.concrete_fix}</p>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="Quality control" subtitle="Deterministic rule scan plus AI review">
        {blocking.length > 0 && (
          <div className="mb-4 rounded-lg border border-red-900/60 bg-red-950/30 p-3">
            <p className="text-xs font-medium text-red-300">Blocking findings</p>
            <ul className="mt-1 list-disc pl-5 text-sm text-red-200/80">
              {blocking.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          </div>
        )}
        <ul className="space-y-1.5">
          {qaChecks.map((check) => (
            <li key={check.check} className="flex items-start gap-2 text-sm">
              <span className={check.passed ? "text-emerald-400" : "text-red-400"}>
                {check.passed ? "✓" : "✕"}
              </span>
              <span className="text-sand">{check.check.replace(/_/g, " ")}</span>
              <span className="text-muted">— {check.detail}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Attach footage" subtitle="Link raw clips your team uploaded">
        {assets.length === 0 ? (
          <Empty>
            No footage uploaded yet. <Link href="/assets" className="text-rose hover:underline">Upload clips →</Link>
          </Empty>
        ) : (
          <div className="flex flex-wrap gap-2">
            {assets.slice(0, 12).map((asset) => (
              <button key={asset.id} onClick={() => attach(asset.id)} disabled={busy}
                      className="chip hover:border-rose hover:text-sand">
                {asset.filename} · {asset.footage_type}
              </button>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
