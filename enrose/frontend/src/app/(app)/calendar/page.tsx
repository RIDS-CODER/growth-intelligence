"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { get, patch, post, type CalendarEntry } from "@/lib/api";
import { Empty, ErrorNote, Section, Spinner } from "@/components/ui";

const FORMAT_TONE: Record<string, string> = {
  reel: "border-rose/50 text-rose-soft",
  carousel: "border-sky-800 text-sky-300",
  static: "border-ink-600 text-muted",
};

export default function CalendarPage() {
  const [entries, setEntries] = useState<CalendarEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const load = useCallback(async () => {
    try {
      setEntries(await get<CalendarEntry[]>("/api/v1/calendar"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the calendar");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const result = await post<any>("/api/v1/calendar/generate", { days: 30 });
      setNote(`Created ${result.entries.length} slots: ${JSON.stringify(result.counts)}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Calendar generation failed");
    } finally {
      setBusy(false);
    }
  }

  /** Drag-and-drop reschedule: keeps the time of day, moves the date. */
  async function moveTo(entryId: string, day: Date) {
    const entry = entries?.find((e) => e.id === entryId);
    if (!entry) return;
    const original = new Date(entry.scheduled_for);
    const next = new Date(day);
    next.setHours(original.getHours(), original.getMinutes(), 0, 0);
    try {
      await patch(`/api/v1/calendar/${entryId}`, { scheduled_for: next.toISOString() });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reschedule failed");
    }
  }

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const leadingBlanks = (first.getDay() + 6) % 7; // week starts Monday

  const byDay = new Map<string, CalendarEntry[]>();
  for (const entry of entries ?? []) {
    const key = new Date(entry.scheduled_for).toDateString();
    byDay.set(key, [...(byDay.get(key) ?? []), entry]);
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label">Calendar</p>
          <h1 className="mt-1 font-display text-3xl text-sand">
            {month.toLocaleString(undefined, { month: "long", year: "numeric" })}
          </h1>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>←</button>
          <button className="btn-ghost" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>→</button>
          <button className="btn-primary" onClick={generate} disabled={busy}>
            {busy ? "Planning…" : "Generate calendar"}
          </button>
        </div>
      </header>

      <ErrorNote error={error} />
      {note && (
        <p className="rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-300">
          {note}
        </p>
      )}

      {!entries ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <Empty>
          No calendar yet. Generate one — it lays your strategy&apos;s format split into dated slots.
        </Empty>
      ) : (
        <>
          <p className="text-sm text-muted">Drag a card onto another day to reschedule it.</p>
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl2 border border-ink-800 bg-ink-800 text-xs">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <div key={d} className="bg-ink-900 px-2 py-2 text-center text-muted">{d}</div>
            ))}

            {Array.from({ length: leadingBlanks }).map((_, i) => (
              <div key={`blank-${i}`} className="min-h-24 bg-ink-950/60" />
            ))}

            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = new Date(month.getFullYear(), month.getMonth(), i + 1);
              const dayEntries = byDay.get(day.toDateString()) ?? [];
              const isToday = day.toDateString() === new Date().toDateString();
              return (
                <div
                  key={day.toISOString()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => { if (dragging) { moveTo(dragging, day); setDragging(null); } }}
                  className={`min-h-24 space-y-1 bg-ink-900 p-1.5 ${isToday ? "ring-1 ring-inset ring-rose/40" : ""}`}
                >
                  <p className={`px-1 ${isToday ? "text-rose" : "text-muted"}`}>{i + 1}</p>
                  {dayEntries.map((entry) => {
                    const card = (
                      <div
                        draggable
                        onDragStart={() => setDragging(entry.id)}
                        className={`cursor-grab rounded border bg-ink-850 px-1.5 py-1 active:cursor-grabbing ${FORMAT_TONE[entry.format] ?? "border-ink-700 text-muted"}`}
                      >
                        <p className="truncate text-[10px] font-medium">
                          {entry.topic ?? entry.format}
                        </p>
                        <p className="truncate text-[10px] opacity-70">{entry.slot_label}</p>
                      </div>
                    );
                    return entry.content_item_id ? (
                      <Link key={entry.id} href={`/content/${entry.content_item_id}`}>{card}</Link>
                    ) : (
                      <div key={entry.id}>{card}</div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          <Section title="All slots" subtitle={`${entries.length} planned`}>
            <ul className="divide-y divide-ink-800">
              {entries.slice(0, 40).map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate text-sand">{entry.topic ?? `${entry.format} slot`}</p>
                    <p className="text-xs text-muted">
                      {new Date(entry.scheduled_for).toLocaleString(undefined, {
                        weekday: "short", day: "numeric", month: "short",
                        hour: "2-digit", minute: "2-digit",
                      })}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <span className="chip">{entry.format}</span>
                    <span className="chip">{entry.pillar.replace(/_/g, " ")}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}
