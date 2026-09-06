import Link from "next/link";
import { getAdmin, isDemoMode } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Landing page.
 *
 * Deliberately says nothing about configuration state. Listing which
 * environment variables are set tells an unauthenticated visitor how the
 * deployment is wired and what is missing — useful to the operator, but the
 * operator can read `npm run db:status` or /api/health instead.
 */
export default async function HomePage() {
  const user = await getAdmin();
  const demo = isDemoMode();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <div className="mb-10">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
          Obsidian vault · RAG · email
        </div>
        <h1 className="text-4xl font-semibold tracking-tight">Obsi-Relay</h1>
        <p className="mt-3 max-w-xl text-[var(--color-muted)]">
          Indexes an Obsidian vault and answers questions that arrive by email, with a
          grounding check between every draft and the outbox.
        </p>
      </div>

      {demo && (
        <div className="callout mb-5 max-w-xl">
          <strong>Live demo.</strong> No sign-in required — open the dashboard and try anything:
          upload a vault, ask the playground a question, inspect a trace, approve a reply.
        </div>
      )}

      <div className="flex items-center gap-3">
        {user ? (
          <Link href="/dashboard" className="btn-primary press">
            {demo ? "Enter the demo" : "Open dashboard"}
          </Link>
        ) : (
          <Link href="/login" className="btn-primary press">
            Sign in
          </Link>
        )}
      </div>

      {user && !demo && (
        <p className="mt-4 text-xs text-[var(--color-muted)]">Signed in as {user.email}</p>
      )}
    </main>
  );
}
