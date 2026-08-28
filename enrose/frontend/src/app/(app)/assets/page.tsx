"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { API_BASE, get, getToken, post, upload, type Asset } from "@/lib/api";
import { Empty, ErrorNote, Score, Section, Spinner } from "@/components/ui";

const FOOTAGE_TYPES = [
  "before", "wash", "cut", "color", "treatment", "styling",
  "after", "reaction", "detail", "bts", "product", "salon", "untagged",
];

export default function AssetsPage() {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [footageType, setFootageType] = useState("before");
  const [shootGroup, setShootGroup] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [analysis, setAnalysis] = useState<any>(null);
  const [checklist, setChecklist] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setAssets(await get<Asset[]>("/api/v1/assets"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load assets");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleUpload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    let uploaded = 0;
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        form.append("footage_type", footageType);
        if (shootGroup) form.append("shoot_group", shootGroup);
        await upload<Asset>("/api/v1/assets", form);
        uploaded += 1;
      }
      setNote(`Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"}`);
      await load();
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function analyse() {
    setBusy(true);
    setError(null);
    try {
      const result = await post<any>("/api/v1/assets/analyze", {
        shoot_group: shootGroup || undefined,
      });
      setAnalysis(result.analysis);
      setNote(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setBusy(false);
    }
  }

  async function buildChecklist() {
    setBusy(true);
    try {
      const result = await post<any>("/api/v1/assets/capture-checklist", {});
      setChecklist(result.checklist);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Checklist failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <p className="label">Assets</p>
        <h1 className="mt-1 font-display text-3xl text-sand">Raw footage</h1>
        <p className="mt-1 text-sm text-muted">
          Upload what your team filmed. The AI decides what can be built from it — and what is missing.
        </p>
      </header>

      <ErrorNote error={error} />
      {note && (
        <p className="rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-300">
          {note}
        </p>
      )}

      <Section title="Upload" subtitle="Tag each clip so the analyst can sequence it properly.">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="ftype">Footage type</label>
            <select id="ftype" value={footageType} onChange={(e) => setFootageType(e.target.value)} className="input mt-1.5">
              {FOOTAGE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="group">Shoot group (optional)</label>
            <input id="group" value={shootGroup} onChange={(e) => setShootGroup(e.target.value)}
                   placeholder="e.g. tuesday-balayage" className="input mt-1.5" />
          </div>
          <div>
            <label className="label" htmlFor="file">Files</label>
            <input ref={fileRef} id="file" type="file" multiple accept="video/*,image/*"
                   onChange={(e) => handleUpload(e.target.files)} disabled={busy}
                   className="input mt-1.5 file:mr-3 file:rounded file:border-0 file:bg-ink-800 file:px-2 file:py-1 file:text-sand" />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={analyse} disabled={busy || !assets?.length} className="btn-primary">
            Analyse footage
          </button>
          <button onClick={buildChecklist} disabled={busy} className="btn-ghost">
            This week&apos;s filming checklist
          </button>
        </div>
      </Section>

      {analysis && (
        <Section title="Footage analysis" subtitle={analysis.recommended_reel}>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Score value={analysis.completeness} label="Complete" />
            <span className="chip">{analysis.verdict.replace(/_/g, " ")}</span>
            <span className="chip">{analysis.coverage?.clips} clips</span>
          </div>

          <p className="text-sm text-muted">{analysis.notes}</p>

          {analysis.sequence?.length > 0 && (
            <div className="mt-4">
              <p className="label">Recommended sequence</p>
              <ol className="mt-2 space-y-2">
                {analysis.sequence.map((step: any) => (
                  <li key={step.order} className="rounded-lg border border-ink-800 p-2.5 text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="text-sand">{step.order}. {step.purpose}</span>
                      <span className="chip shrink-0">{step.start_s}s–{step.end_s}s</span>
                    </div>
                    {step.overlay_text && (
                      <p className="mt-1 text-xs text-rose-soft">Overlay: “{step.overlay_text}”</p>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {analysis.missing_shots?.length > 0 && (
            <div className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
              <p className="text-xs font-medium text-amber-300">Film these next</p>
              <ul className="mt-2 space-y-2">
                {analysis.missing_shots.map((shot: any) => (
                  <li key={shot.shot} className="text-sm">
                    <p className="text-amber-200">{shot.shot} <span className="text-amber-200/60">({shot.duration_s}s)</span></p>
                    <p className="text-xs text-amber-200/70">{shot.why_it_matters}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      {checklist && (
        <Section
          title="Content capture checklist"
          subtitle={`~${checklist.total_estimated_minutes} minutes of filming covers about ${checklist.covers_content_items} content items`}
        >
          <div className="grid gap-3 md:grid-cols-2">
            {checklist.days.map((day: any) => (
              <div key={day.day} className="rounded-lg border border-ink-800 p-3">
                <p className="text-sm font-medium uppercase tracking-wide text-sand">{day.day}</p>
                <p className="text-xs text-muted">{day.focus}</p>
                <ul className="mt-2 space-y-1.5">
                  {day.tasks.map((task: any) => (
                    <li key={task.shot} className="text-sm">
                      <span className="text-muted">☐</span>{" "}
                      <span className="text-sand">{task.shot}</span>{" "}
                      <span className="text-xs text-muted">({task.duration_s}s)</span>
                      <p className="ml-4 text-xs text-muted/70">{task.why}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted">{checklist.notes}</p>
        </Section>
      )}

      <Section title="Library" subtitle={assets ? `${assets.length} files` : ""}>
        {!assets ? <Spinner /> : assets.length === 0 ? (
          <Empty>No footage yet. Upload clips filmed during a normal appointment.</Empty>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {assets.map((asset) => (
              <div key={asset.id} className="rounded-lg border border-ink-800 p-3">
                <p className="truncate text-sm text-sand">{asset.filename}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="chip">{asset.footage_type}</span>
                  <span className="chip">{asset.kind}</span>
                  {asset.duration_s && <span className="chip">{asset.duration_s.toFixed(1)}s</span>}
                </div>
                {asset.shoot_group && (
                  <p className="mt-2 text-xs text-muted">Group: {asset.shoot_group}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
