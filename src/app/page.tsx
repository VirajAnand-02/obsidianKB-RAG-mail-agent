import Link from "next/link";
import { redirect } from "next/navigation";
import { checkReadiness } from "@/lib/env";
import { getAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Landing and setup page.
 *
 * Deliberately works with an empty `.env`: the first thing a new deployment
 * needs is a list of what is still unconfigured, not a crash or a redirect loop
 * into a login it cannot serve yet.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; token_hash?: string; type?: string }>;
}) {
  const params = await searchParams;

  // A sign-in code should arrive at /auth/callback, but Supabase falls back to
  // the project's Site URL when the requested redirect is not in its allow
  // list — and the Site URL has no path, so the code lands here instead.
  // Forwarding it means a misconfigured allow list degrades to a working login
  // rather than a blank page holding a valid credential.
  if (params.code) {
    redirect(`/auth/callback?code=${encodeURIComponent(params.code)}`);
  }
  if (params.token_hash && params.type) {
    redirect(
      `/auth/callback?token_hash=${encodeURIComponent(params.token_hash)}` +
        `&type=${encodeURIComponent(params.type)}`,
    );
  }

  const readiness = checkReadiness();
  const user = await getAdmin();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <div className="mb-10">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
          Obsidian vault · RAG · email
        </div>
        <h1 className="text-4xl font-semibold tracking-tight">Obsi-Relay</h1>
        <p className="mt-3 max-w-xl text-[var(--color-muted)]">
          Indexes an Obsidian vault, answers questions that arrive by email, and sends a
          scheduled digest — with a grounding check between every draft and the outbox.
        </p>
      </div>

      <div className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-medium">Setup</h2>
          <span
            className={`badge ${
              readiness.ok
                ? "border-[#1f4d2a] bg-[#12261a] text-[var(--color-ok)]"
                : "border-[#5c4a1a] bg-[#241f10] text-[var(--color-warn)]"
            }`}
          >
            {readiness.ok ? "Ready" : `${readiness.checks.length} to configure`}
          </span>
        </div>

        <ul className="space-y-2 text-sm">
          {readiness.all.map((check) => (
            <li key={check.key} className="flex items-start gap-3">
              <span
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                  check.ok ? "bg-[var(--color-ok)]" : "bg-[var(--color-bad)]"
                }`}
              />
              <span className="flex-1">
                <code className="text-[13px] text-[var(--color-ink)]">{check.key}</code>
                <span className="ml-2 text-[var(--color-muted)]">— {check.feature}</span>
              </span>
              <span className="text-xs text-[var(--color-muted)]">
                {check.ok ? "set" : "missing"}
              </span>
            </li>
          ))}
        </ul>

        {!readiness.ok && (
          <p className="mt-4 border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-muted)]">
            Fill these in <code>.env</code> (see <code>.env.example</code>), then run{" "}
            <code className="text-[var(--color-ink)]">npm run db:init</code>.
          </p>
        )}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Link href="/dashboard" className="btn-primary">
          Open dashboard
        </Link>
        {!user && (
          <Link href="/login" className="btn-ghost">
            Sign in
          </Link>
        )}
        <a href="/api/health" className="btn-ghost">
          Health check
        </a>
      </div>

      {user && (
        <p className="mt-4 text-xs text-[var(--color-muted)]">Signed in as {user.email}</p>
      )}
    </main>
  );
}
