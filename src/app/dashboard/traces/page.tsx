import { listTraces, traceCounts, type TraceOutcome } from "@/lib/traces";
import LiveTraceList from "@/components/LiveTraceList";
import { errorMessage } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Every inbound message and what happened to it.
 *
 * Deliberately lists messages that were *ignored* alongside answered ones.
 * A message the system silently dropped is exactly the case that is otherwise
 * invisible, and it was a filter bug that hid four real emails here before.
 *
 * Rendered on the server for the first paint, then handed to a client component
 * that keeps it current as mail arrives — the same split as the detail view.
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

      {/* Keyed on the filter so a new query starts from its own server render
          rather than inheriting the previous list's state. */}
      <LiveTraceList
        key={`${outcome}:${search}`}
        initial={{ traces, counts }}
        outcome={outcome}
        search={search}
      />
    </div>
  );
}
