"use client";

import { useEffect, useState } from "react";

import { get } from "@/lib/api";
import { Empty, ErrorNote, Section, Spinner } from "@/components/ui";

interface Lead {
  id: string;
  handle: string | null;
  name: string | null;
  source: string;
  intent: string;
  score: number;
  status: string;
  requested_service: string | null;
  message: string | null;
  created_at: string;
}

const INTENT_TONE: Record<string, string> = {
  high: "border-emerald-800 text-emerald-300",
  medium: "border-amber-800 text-amber-300",
  low: "border-ink-700 text-muted",
  unknown: "border-ink-700 text-muted",
};

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<Lead[]>("/api/v1/leads")
      .then(setLeads)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load leads"));
  }, []);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <p className="label">Leads</p>
        <h1 className="mt-1 font-display text-3xl text-sand">Enquiries and booking intent</h1>
        <p className="mt-1 text-sm text-muted">
          Content is ranked by bookings, not views — this is where that attribution starts.
        </p>
      </header>

      <ErrorNote error={error} />

      <Section title="Pipeline">
        {!leads ? <Spinner /> : leads.length === 0 ? (
          <Empty>
            No leads yet. Lead capture from comments and DMs arrives in Phase 3 — the schema and
            attribution links are already in place, so nothing is lost in the meantime.
          </Empty>
        ) : (
          <ul className="space-y-2">
            {leads.map((lead) => (
              <li key={lead.id} className="rounded-lg border border-ink-800 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-sand">{lead.handle ?? lead.name ?? "Unknown"}</p>
                    {lead.message && <p className="mt-1 text-sm text-muted">“{lead.message}”</p>}
                  </div>
                  <span className={`chip shrink-0 ${INTENT_TONE[lead.intent]}`}>
                    {lead.intent} intent
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="chip">{lead.source.replace(/_/g, " ")}</span>
                  <span className="chip">{lead.status}</span>
                  {lead.requested_service && <span className="chip">{lead.requested_service}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
