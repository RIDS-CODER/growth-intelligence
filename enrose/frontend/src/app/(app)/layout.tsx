"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { clearToken, get, getToken, type Health } from "@/lib/api";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/calendar", label: "Calendar" },
  { href: "/content", label: "Content" },
  { href: "/assets", label: "Assets" },
  { href: "/brand", label: "Brand Brain" },
  { href: "/strategy", label: "Strategy" },
  { href: "/trends", label: "Trends" },
  { href: "/competitors", label: "Competitors" },
  { href: "/analytics", label: "Analytics" },
  { href: "/leads", label: "Leads" },
  { href: "/settings", label: "Settings" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    setReady(true);
    get<Health>("/health").then(setHealth).catch(() => setHealth(null));
  }, [router]);

  useEffect(() => setNavOpen(false), [pathname]);

  if (!ready) return null;

  const mocked = health
    ? Object.entries(health.providers).filter(([, v]) => v === "mock" || v === "local")
    : [];

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="border-b border-ink-800 bg-ink-900/60 lg:min-h-screen lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between p-5">
          <Link href="/dashboard">
            <p className="label">Enrose Salon</p>
            <p className="font-display text-xl text-sand">AI Social</p>
          </Link>
          <button
            className="btn-ghost px-2 py-1 text-xs lg:hidden"
            onClick={() => setNavOpen((v) => !v)}
            aria-expanded={navOpen}
          >
            Menu
          </button>
        </div>

        <nav className={`px-3 pb-4 ${navOpen ? "block" : "hidden"} lg:block`}>
          {NAV.map((entry) => {
            const active = pathname === entry.href || pathname.startsWith(`${entry.href}/`);
            return (
              <Link
                key={entry.href}
                href={entry.href}
                className={`block rounded-lg px-3 py-2 text-sm transition-colors ${
                  active ? "bg-ink-800 text-sand" : "text-muted hover:bg-ink-850 hover:text-sand"
                }`}
              >
                {entry.label}
              </Link>
            );
          })}

          <div className="mt-6 space-y-2 border-t border-ink-800 px-3 pt-4">
            {mocked.length > 0 && (
              <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-2.5">
                <p className="text-[11px] font-medium text-amber-300">Running on mocks</p>
                <p className="mt-1 text-[11px] leading-relaxed text-amber-200/70">
                  {mocked.map(([k, v]) => `${k}: ${v}`).join(" · ")}. Add credentials in{" "}
                  <code className="text-amber-200">.env</code> to go live.
                </p>
              </div>
            )}
            <button
              onClick={() => { clearToken(); router.push("/login"); }}
              className="w-full rounded-lg px-3 py-2 text-left text-sm text-muted hover:bg-ink-850 hover:text-sand"
            >
              Sign out
            </button>
          </div>
        </nav>
      </aside>

      <main className="min-w-0 p-5 lg:p-8">{children}</main>
    </div>
  );
}
