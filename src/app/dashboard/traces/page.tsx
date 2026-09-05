import Link from "next/link";
import { ChevronRight, Search } from "lucide-react";

import { listTraces, traceCounts, type TraceOutcome } from "@/lib/traces";
import OutcomeBadge from "@/components/OutcomeBadge";
import { errorMessage } from "@/lib/logger";

export const dynamic = "force-dynamic";

const FILTERS: (TraceOutcome | "all")[] = [
  "all",
  "sent",
  "awaiting review",
  "blocked",
  "ignored",
  "failed",
];

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Every inbound message and what happened to it.
 *
 * Deliberately lists messages that were *ignored* alongside answered ones.
 * A message the system silently dropped is exactly the case that is otherwise
 * invisible, and it was a filter bug that hid four real emails here before.
 */
export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<{ outcome?: string; q?: string }>;
}) {
  const params = await searchParams;
  const outcome = (params.outcome ?? "all") as TraceOutcome | "all";
  const search = params.q ?? "";

  let traces;
  let counts: Record<string, number> = {};
  try {
    [traces, counts] = await Promise.all([listTraces({ outcome, search }), traceCounts()]);
  } catch (e) {
    return (
      <div className="card border-[#5c2a2a]">
        <h1 className="font-medium text-[var(--color-bad)]">Could not load traces</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">{errorMessage(e)}</p>
      </div>
    );
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Traces</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Every inbound message, what the system decided, and what it sent back.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const active = outcome === f;
          const count = counts[f] ?? 0;
          return (
            <Link
              key={f}
              href={`/dashboard/traces?outcome=${encodeURIComponent(f)}${search ? `&q=${encodeURIComponent(search)}` : ""}`}
              className={`badge press transition-colors ${
                active
                  ? "border-[var(--color-accent)] bg-[var(--color-surface-2)] text-[var(--color-ink)]"
                  : "border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              }`}
            >
              {f}
              <span className="ml-1 tabular-nums opacity-60">{count}</span>
            </Link>
          );
        })}

        <form action="/dashboard/traces" className="ml-auto flex items-center gap-2">
          {outcome !== "all" && <input type="hidden" name="outcome" value={outcome} />}
          <div className="relative">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted)]"
            />
            <input
              name="q"
              defaultValue={search}
              placeholder="sender or subject"
              className="input w-56 py-1.5 pl-8 text-xs"
            />
          </div>
        </form>
      </div>

      {traces.length === 0 ? (
        <div className="card animate-rise-in text-center">
          <p className="font-medium">Nothing here yet</p>
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">
            {search || outcome !== "all"
              ? "No messages match this filter."
              : "Inbound messages will appear here as they arrive."}
          </p>
        </div>
      ) : (
        <div className="card stagger divide-y divide-[var(--color-border-soft)] p-0">
          {traces.map((t) => (
            <Link
              key={t.inboundId}
              href={`/dashboard/traces/${t.inboundId}`}
              className="row-hover flex items-center gap-3 px-5 py-3.5 hover:bg-[var(--color-surface-3)]"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {t.subject || "(no subject)"}
                </p>
                <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">
                  {t.fromEmail}
                  {t.question ? ` — ${t.question.slice(0, 80)}` : ""}
                  {t.reason ? ` — ${t.reason}` : ""}
                </p>
              </div>

              <span className="hidden shrink-0 text-xs tabular-nums text-[var(--color-muted)] sm:block">
                {t.durationMs !== null ? `${(t.durationMs / 1000).toFixed(1)}s` : ""}
              </span>
              <span className="shrink-0 text-xs text-[var(--color-muted)]">
                {relativeTime(t.receivedAt)}
              </span>

              <OutcomeBadge outcome={t.outcome} score={t.groundingScore} />
              <ChevronRight size={14} className="shrink-0 text-[var(--color-muted)]" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
