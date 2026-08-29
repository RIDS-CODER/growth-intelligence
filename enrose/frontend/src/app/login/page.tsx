"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { API_BASE, setToken } from "@/lib/api";
import { ErrorNote } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("owner@enrosesalon.com");
  const [password, setPassword] = useState("enrose-dev-password");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail ?? "Sign-in failed");
      }
      setToken((await response.json()).access_token);
      router.push("/dashboard");
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message}. Is the API running at ${API_BASE}?`
          : "Sign-in failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="label">Enrose Salon</p>
          <h1 className="mt-2 font-display text-3xl text-sand">AI Social</h1>
          <p className="mt-2 text-sm text-muted">
            Your AI social media manager, creative director and content operations engine.
          </p>
        </div>

        <form onSubmit={submit} className="card space-y-4">
          <ErrorNote error={error} />
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input
              id="email" type="email" required value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input mt-1.5" autoComplete="username"
            />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password" type="password" required value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input mt-1.5" autoComplete="current-password"
            />
          </div>
          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <p className="text-center text-xs text-muted">
            Seeded development credentials are pre-filled. Change them before any real deployment.
          </p>
        </form>
      </div>
    </main>
  );
}
