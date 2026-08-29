"use client";

import { useCallback, useEffect, useState } from "react";

import { get, post, type ContentItem } from "@/lib/api";
import { ContentCard, Empty, ErrorNote, Section, Spinner } from "@/components/ui";

const STATUSES = [
  "", "ready_for_approval", "draft", "client_approved", "scheduled",
  "published", "rejected", "learned",
];

export default function ContentPage() {
  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [status, setStatus] = useState("");
  const [format, setFormat] = useState("reel");
  const [count, setCount] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const query = status ? `?status=${status}` : "";
      setItems(await get<ContentItem[]>(`/api/v1/content${query}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load content");
    }
  }, [status]);

  useEffect(() => {
    // Deep links from the dashboard pipeline arrive with ?status=…
    const initial = new URLSearchParams(window.location.search).get("status");
    if (initial) setStatus(initial);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function generate() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await post<any>("/api/v1/content/generate", { format, count });
      const rejected = result.rejected?.length ?? 0;
      setNote(
        `Generated ${result.items.length} ${format}${result.items.length === 1 ? "" : "s"}` +
          (rejected ? ` · ${rejected} auto-rejected by quality control` : "") +
          ` · $${result.cost_usd.toFixed(4)} (${result.provider})`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label">Content</p>
          <h1 className="mt-1 font-display text-3xl text-sand">Production pipeline</h1>
        </div>
      </header>

      <Section
        title="Generate content"
        subtitle="Each draft runs through virality scoring, a safety scan and QA before it reaches you."
      >
        <ErrorNote error={error} />
        {note && (
          <p className="mb-3 rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-300">
            {note}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label" htmlFor="format">Format</label>
            <select
              id="format" value={format} onChange={(e) => setFormat(e.target.value)}
              className="input mt-1.5 w-40"
            >
              <option value="reel">Reel</option>
              <option value="carousel">Carousel</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="count">How many</label>
            <input
              id="count" type="number" min={1} max={10} value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="input mt-1.5 w-24"
            />
          </div>
          <button onClick={generate} disabled={busy} className="btn-primary">
            {busy ? "Generating…" : "Generate"}
          </button>
        </div>
      </Section>

      <div className="flex flex-wrap gap-2">
        {STATUSES.map((value) => (
          <button
            key={value || "all"}
            onClick={() => setStatus(value)}
            className={`chip ${status === value ? "border-rose text-sand" : "hover:border-ink-600"}`}
          >
            {value ? value.replace(/_/g, " ") : "all"}
          </button>
        ))}
      </div>

      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Empty>No content{status ? ` with status “${status.replace(/_/g, " ")}”` : ""} yet.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => <ContentCard key={item.id} item={item} />)}
        </div>
      )}
    </div>
  );
}
