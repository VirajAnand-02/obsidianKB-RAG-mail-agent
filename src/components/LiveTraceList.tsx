"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronRight, Search } from "lucide-react";

import OutcomeBadge from "@/components/OutcomeBadge";
import type { TraceOutcome, TraceSummary } from "@/lib/traces";

/**
 * The trace list, kept current while the page is open.
 *
 * Mail arrives on a webhook, not on a click, so a static list is stale the
 * moment something lands. This polls the same data the server rendered and
 * swaps it in, which is enough because the pipeline records each stage as it
 * runs — see the detail view for the same reasoning at a finer grain.
 *
 * Three things keep the polling from being a nuisance:
 *
 *  - The cadence follows the work. A mailbox at rest is checked every few
 *    seconds; while a pipeline is mid-flight it matches the detail view, so a
 *    row moves from "processing" to its outcome at roughly the speed the
 *    detail page would show it.
 *  - A hidden tab does not poll at all, and refreshes the instant it is looked
 *    at again. A dashboard left open in a background tab otherwise queries all
 *    day for nobody.
 *  - Rows that arrived while you were watching are marked briefly, because a
 *    list that silently reorders itself is worse than one that does not move.
 */

const FILTERS: (TraceOutcome | "all")[] = [
  "all",
  "sent",
  "awaiting review",
  "blocked",
  "ignored",
  "failed",
];

/** Cadence when every trace has reached a terminal outcome. */
const IDLE_POLL_MS = 5000;
/** Cadence while a pipeline is still running, matching LiveTrace. */
const ACTIVE_POLL_MS = 1500;
/** How long a newly arrived row stays marked. */
const NEW_ROW_MS = 8000;
/** Relative timestamps are cheap to recompute and look wrong if they are not. */
const CLOCK_TICK_MS = 30000;

function relativeTime(iso: string, now: number): string {
  const mins = Math.round((now - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export interface TraceListData {
  traces: TraceSummary[];
  counts: Record<string, number>;
}

export default function LiveTraceList({
  initial,
  outcome,
  search,
}: {
  initial: TraceListData;
  outcome: TraceOutcome | "all";
  search: string;
}) {
  const [traces, setTraces] = useState(initial.traces);
  const [counts, setCounts] = useState(initial.counts);
  const [connected, setConnected] = useState(true);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  // Everything present at first paint is already known, so nothing is marked
  // "new" on load — only what turns up while the page is open.
  const seenRef = useRef(new Set(initial.traces.map((t) => t.inboundId)));
  const activeRef = useRef(false);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  activeRef.current = traces.some((t) => t.outcome === "processing");

  const query = (() => {
    const params = new URLSearchParams();
    if (outcome !== "all") params.set("outcome", outcome);
    if (search) params.set("q", search);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  })();

  const markNew = useCallback((ids: string[]) => {
    setNewIds((prev) => new Set([...prev, ...ids]));
    const timer = setTimeout(() => {
      setNewIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    }, NEW_ROW_MS);
    timeoutsRef.current.push(timer);
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/traces${query}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Trace poll failed (${res.status})`);

      const json = (await res.json()) as { traces?: TraceSummary[]; counts?: Record<string, number> };
      if (!Array.isArray(json.traces)) throw new Error("Trace poll returned no list");

      const arrived = json.traces
        .map((t) => t.inboundId)
        .filter((id) => !seenRef.current.has(id));
      for (const id of json.traces.map((t) => t.inboundId)) seenRef.current.add(id);

      setTraces(json.traces);
      setCounts(json.counts ?? {});
      setConnected(true);
      if (arrived.length > 0) markNew(arrived);
    } catch {
      // A dropped poll is not worth an error state of its own; the indicator
      // dims and the next tick retries.
      setConnected(false);
    }
  }, [query, markNew]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      timer = setTimeout(run, activeRef.current ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };

    const run = async () => {
      if (!cancelled && document.visibilityState === "visible") await poll();
      if (!cancelled) schedule();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" || cancelled) return;
      clearTimeout(timer);
      void run();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const t of timeoutsRef.current) clearTimeout(t);
      timeoutsRef.current = [];
    };
  }, [poll]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div>
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

        <div className="ml-auto flex items-center gap-2">
          <span
            className="badge border-[var(--color-border)] text-[var(--color-muted)]"
            title={
              connected
                ? "New mail appears here automatically."
                : "The last update could not be fetched; retrying."
            }
            aria-live="polite"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connected ? "animate-pulse bg-[var(--color-accent)]" : "bg-[var(--color-faint)]"
              }`}
            />
            {connected ? "live" : "reconnecting"}
          </span>

          <form action="/dashboard/traces" className="flex items-center gap-2">
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
                <p className="flex items-center gap-2 truncate text-sm font-medium">
                  {newIds.has(t.inboundId) && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)]"
                      title="Arrived just now"
                    />
                  )}
                  <span className="truncate">{t.subject || "(no subject)"}</span>
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
              <span
                className="shrink-0 text-xs text-[var(--color-muted)]"
                suppressHydrationWarning
              >
                {relativeTime(t.receivedAt, now)}
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
