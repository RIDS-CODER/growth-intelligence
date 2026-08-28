"use client";

import { useEffect, useState } from "react";

import { get, type AIActivity, type Health } from "@/lib/api";
import { Empty, ErrorNote, MockBadge, Section, Spinner, Stat } from "@/components/ui";

interface SocialAccount {
  id: string;
  platform: string;
  handle: string | null;
  is_active: boolean;
  is_mock: boolean;
  connected: boolean;
}

export default function SettingsPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [activity, setActivity] = useState<AIActivity | null>(null);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<Health>("/health").then(setHealth).catch(() => setHealth(null));
    get<AIActivity>("/api/v1/ops/ai-activity?limit=25")
      .then(setActivity)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load AI activity"));
    get<SocialAccount[]>("/api/v1/social/accounts").then(setAccounts).catch(() => setAccounts([]));
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <p className="label">Settings</p>
        <h1 className="mt-1 font-display text-3xl text-sand">Connections and operations</h1>
      </header>

      <ErrorNote error={error} />

      <Section
        title="Providers"
        subtitle="Each subsystem runs live if credentials are present, and on a labelled mock if not."
      >
        {!health ? <Spinner /> : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(health.providers).map(([name, value]) => {
              const isMock = value === "mock";
              return (
                <div key={name} className="rounded-lg border border-ink-800 p-3">
                  <p className="label">{name}</p>
                  <p className="mt-1 flex items-center gap-2 text-sm text-sand">
                    {value}
                    <MockBadge show={isMock} />
                  </p>
                </div>
              );
            })}
          </div>
        )}
        {health && (
          <div className="mt-4">
            <p className="label">Model tiers</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {Object.entries(health.models).map(([tier, model]) => (
                <span key={tier} className="chip">{tier}: {model}</span>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted">
              Strategy and analysis use the strong tier; captions, stories and classification use the
              cheap tier. Tiering is configuration, not code.
            </p>
          </div>
        )}
      </Section>

      <Section title="Instagram connection">
        {accounts.length === 0 ? (
          <Empty>No account connected.</Empty>
        ) : (
          <ul className="space-y-2">
            {accounts.map((account) => (
              <li key={account.id} className="flex items-center justify-between gap-3 rounded-lg border border-ink-800 p-3">
                <div>
                  <p className="text-sm text-sand">@{account.handle}</p>
                  <p className="text-xs text-muted">{account.platform}</p>
                </div>
                <div className="flex gap-2">
                  <MockBadge show={account.is_mock} />
                  <span className="chip">{account.connected ? "token stored" : "no token"}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">
          Real publishing requires a Meta app with <code>instagram_content_publish</code> and
          <code> instagram_manage_insights</code>, plus app review. Set <code>META_APP_ID</code> and
          <code> META_APP_SECRET</code> to switch off the mock. No browser automation is used, ever.
        </p>
      </Section>

      <Section title="AI activity" subtitle="Every model call is logged with its cost">
        {!activity ? <Spinner /> : (
          <>
            <div className="grid gap-4 sm:grid-cols-4">
              <Stat label="Calls" value={activity.totals.calls} />
              <Stat label="Cost" value={`$${activity.totals.cost_usd.toFixed(4)}`} />
              <Stat label="Input tokens" value={activity.totals.input_tokens.toLocaleString()} />
              <Stat label="Output tokens" value={activity.totals.output_tokens.toLocaleString()} />
            </div>

            {activity.by_agent.length > 0 && (
              <div className="mt-5">
                <p className="label">By agent</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {activity.by_agent
                    .sort((a, b) => b.calls - a.calls)
                    .map((row) => (
                      <span key={row.agent} className="chip">
                        {row.agent.replace(/_/g, " ")}{" "}
                        <span className="font-semibold text-sand">{row.calls}</span>
                      </span>
                    ))}
                </div>
              </div>
            )}

            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-muted">
                  <tr className="border-b border-ink-800">
                    <th className="py-2 pr-4 font-normal">Agent</th>
                    <th className="py-2 pr-4 font-normal">Model</th>
                    <th className="py-2 pr-4 font-normal">Tokens</th>
                    <th className="py-2 pr-4 font-normal">Time</th>
                    <th className="py-2 font-normal">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.entries.map((entry) => (
                    <tr key={entry.id} className="border-b border-ink-800/60">
                      <td className="py-2 pr-4 text-sand">{entry.agent.replace(/_/g, " ")}</td>
                      <td className="py-2 pr-4 text-muted">{entry.model}</td>
                      <td className="py-2 pr-4 text-muted">
                        {entry.input_tokens}/{entry.output_tokens}
                      </td>
                      <td className="py-2 pr-4 text-muted">{entry.duration_ms}ms</td>
                      <td className="py-2">
                        <span className={entry.success ? "text-emerald-400" : "text-red-400"}>
                          {entry.success ? "ok" : "failed"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>

      <Section title="Approval policy">
        <ul className="space-y-2 text-sm">
          <li className="rounded-lg border border-ink-800 p-3">
            <p className="text-sand">Level 1 — human approves everything</p>
            <p className="text-xs text-muted">Currently active. The default and the safe choice.</p>
          </li>
          <li className="rounded-lg border border-ink-800 p-3">
            <p className="text-sand">Level 2 — auto-publish low-risk content</p>
            <p className="text-xs text-muted">
              Disabled. Requires a clean safety scan, no blocking QA findings, and an overall score
              of 75 or above.
            </p>
          </li>
          <li className="rounded-lg border border-ink-800 p-3">
            <p className="text-sand">Level 3 — mandatory human approval</p>
            <p className="text-xs text-muted">
              Always enforced for campaigns, offers and any factual claim. Cannot be turned off.
            </p>
          </li>
        </ul>
      </Section>
    </div>
  );
}
