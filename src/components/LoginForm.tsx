"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

/**
 * Password sign-in for the single admin account.
 *
 * Credentials live in ADMIN_EMAIL / ADMIN_PASSWORD. The server returns one
 * deliberately vague error for any failure, so this page cannot be used to work
 * out which half was wrong.
 */
export default function LoginForm() {
  return (
    <Suspense>
      <LoginFields />
    </Suspense>
  );
}

function LoginFields() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json();

      if (!res.ok) throw new Error(json.error ?? "Sign-in failed.");

      // refresh() so the server components re-render with the new session
      // before navigating, otherwise the dashboard renders as signed out once.
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <Link href="/" className="mb-8 text-sm text-[var(--color-muted)] hover:text-[var(--color-ink)]">
        ← Obsi-Relay
      </Link>

      <div className="card">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">
          Use the admin credentials from your environment.
        </p>

        <form onSubmit={submit} className="mt-6">
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@yourdomain.com"
            className="input"
          />

          <label className="label mt-4" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="input"
          />

          {error && <p className="mt-3 text-sm text-[var(--color-bad)]">{error}</p>}

          <button
            type="submit"
            disabled={busy || !email.trim() || !password}
            className="btn-primary mt-5 w-full"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>

      <p className="mt-4 text-center text-xs text-[var(--color-muted)]">
        Set <code>ADMIN_EMAIL</code> and <code>ADMIN_PASSWORD</code> in <code>.env</code>.
      </p>
    </main>
  );
}
