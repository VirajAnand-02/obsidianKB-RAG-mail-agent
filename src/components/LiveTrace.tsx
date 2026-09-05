"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, Check, Loader2 } from "lucide-react";

import CollapsibleJson from "@/components/CollapsibleJson";
import OutcomeBadge from "@/components/OutcomeBadge";
import type { TraceDetail } from "@/lib/traces";

/**
 * One message, end to end, updating while it runs.
 *
 * The pipeline writes each stage to the database as it completes, so a trace
 * opened mid-flight fills in progressively. Two behaviours make that readable:
 *
 *  - Stages animate in as they arrive, and the stage currently in progress is
 *    marked, so the page shows *where* the work is rather than just spinning.
 *  - The view follows the newest stage, but only while the reader is already at
 *    the bottom. Scrolling up to re-read an earlier stage pins the view in
 *    place; yanking it away mid-sentence would be worse than not following at
 *    all. A "jump to latest" affordance appears instead.
 */

const POLL_MS = 1500;
/** Distance from the bottom still treated as "following". */
const FOLLOW_THRESHOLD_PX = 120;

type StageState = "done" | "running" | "pending" | "skipped";

interface Stage {
  key: string;
  label: string;
  state: StageState;
  render: () => React.ReactNode;
}

function isTerminal(trace: TraceDetail): boolean {
  return trace.outcome !== "processing";
}

export default function LiveTrace({
  initial,
  scrollContainerId = "dashboard-scroll",
}: {
  initial: TraceDetail;
  scrollContainerId?: string;
}) {
  const [trace, setTrace] = useState<TraceDetail>(initial);
  const [following, setFollowing] = useState(true);
  const [hasNewBelow, setHasNewBelow] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const stageCountRef = useRef(0);
  const running = !isTerminal(trace);

  // ---- polling ------------------------------------------------------------
  useEffect(() => {
    if (!running) return;

    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/traces/${trace.inboundId}`, { cache: "no-store" });
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled && json.trace) setTrace(json.trace as TraceDetail);
      } catch {
        // A dropped poll is not worth surfacing; the next tick retries.
      }
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [running, trace.inboundId]);

  // ---- follow-the-tail, unless the reader scrolled away --------------------
  const container = useCallback(
    () => document.getElementById(scrollContainerId),
    [scrollContainerId],
  );

  useEffect(() => {
    const el = container();
    if (!el) return;

    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distance < FOLLOW_THRESHOLD_PX;
      setFollowing(atBottom);
      if (atBottom) setHasNewBelow(false);
    };

    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [container]);

  const stages = buildStages(trace);

  // useLayoutEffect so the scroll happens in the same frame the stage paints,
  // which avoids a visible jump.
  useLayoutEffect(() => {
    const grew = stages.length > stageCountRef.current;
    stageCountRef.current = stages.length;
    if (!grew) return;

    if (following) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    else setHasNewBelow(true);
  }, [stages.length, following]);

  function jumpToLatest() {
    setFollowing(true);
    setHasNewBelow(false);
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  return (
    <div className="pb-12">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{trace.subject || "(no subject)"}</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            from {trace.fromEmail}
            {trace.toEmail ? ` → ${trace.toEmail}` : ""} ·{" "}
            {new Date(trace.receivedAt).toLocaleString()}
            {trace.durationMs !== null &&
              ` · answered in ${(trace.durationMs / 1000).toFixed(1)}s`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {running && (
            <span className="badge animate-fade-in border-[var(--color-accent)] text-[var(--color-accent-soft)]">
              <Loader2 size={10} className="animate-spin" /> running
            </span>
          )}
          <OutcomeBadge outcome={trace.outcome} score={trace.groundingScore} />
        </div>
      </header>

      {running && <div className="progress-track mb-5" aria-label="Pipeline running" />}

      <ol className="relative space-y-4 border-l border-[var(--color-border)] pl-6">
        {stages.map((stage, i) => (
          <li key={stage.key} className="animate-rise-in relative">
            <span
              className={`absolute -left-[31px] flex h-5 w-5 items-center justify-center rounded-full border text-[10px] ${
                stage.state === "running"
                  ? "stage-active border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                  : stage.state === "done"
                    ? "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)]"
                    : "border-[var(--color-border-soft)] bg-[var(--color-surface)] text-[var(--color-faint)]"
              }`}
            >
              {stage.state === "running" ? (
                <Loader2 size={10} className="animate-spin" />
              ) : stage.state === "done" ? (
                <Check size={11} />
              ) : (
                i + 1
              )}
            </span>

            <div className="card">
              <h2 className="mb-3 text-sm font-medium">{stage.label}</h2>
              {stage.render()}
            </div>
          </li>
        ))}

        {running && (
          <li className="relative">
            <span className="stage-active absolute -left-[31px] flex h-5 w-5 items-center justify-center rounded-full border border-[var(--color-accent)] bg-[var(--color-accent)]">
              <Loader2 size={10} className="animate-spin text-white" />
            </span>
            <div className="card">
              <div className="space-y-2">
                <div className="skeleton h-3 w-1/3" />
                <div className="skeleton h-2.5 w-3/4" />
                <div className="skeleton h-2.5 w-2/3" />
              </div>
            </div>
          </li>
        )}
      </ol>

      <div ref={bottomRef} />

      <div className="mt-8">
        <CollapsibleJson label="Raw webhook payload" value={trace.raw} />
      </div>

      {hasNewBelow && (
        <button
          onClick={jumpToLatest}
          className="press animate-rise-in fixed bottom-20 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--color-accent)] bg-[var(--color-surface-2)] px-3.5 py-1.5 text-xs text-[var(--color-ink)] shadow-lg"
        >
          <ArrowDown size={12} /> New stage
        </button>
      )}
    </div>
  );
}

/**
 * Derives the visible stages from whatever the trace currently holds.
 *
 * Stage existence is inferred from data rather than a stored status field, so a
 * trace written by an older pipeline version still renders sensibly.
 */
function buildStages(trace: TraceDetail): Stage[] {
  const stages: Stage[] = [];
  const running = !isTerminal(trace);

  stages.push({
    key: "received",
    label: "Received",
    state: "done",
    render: () => (
      <>
        <Field label="Message-ID" value={trace.messageId ?? "—"} mono />
        {trace.textBody && (
          <div className="mt-3">
            <p className="label">Raw body</p>
            <pre className="note-text whitespace-pre-wrap rounded-md bg-[var(--color-canvas)] p-3 text-[var(--color-muted)]">
              {trace.textBody.slice(0, 1500)}
              {trace.textBody.length > 1500 ? "\n…" : ""}
            </pre>
          </div>
        )}
      </>
    ),
  });

  const triaged = trace.inboundStatus !== "received";
  if (triaged || !running) {
    stages.push({
      key: "triage",
      label: "Triage",
      state: "done",
      render: () =>
        trace.inboundStatus === "ignored" ? (
          <p className="text-sm text-[var(--color-bad)]">
            Filtered out — {trace.reason ?? "no reason recorded"}
          </p>
        ) : (
          <>
            <p className="text-sm text-[var(--color-muted)]">
              Accepted as a question{trace.reason ? ` — ${trace.reason}` : ""}.
            </p>
            {trace.question && (
              <div className="mt-3">
                <p className="label">Extracted question</p>
                <p className="rounded-md bg-[var(--color-canvas)] p-3 text-sm">{trace.question}</p>
              </div>
            )}
          </>
        ),
    });
  }

  if (!trace.outbound) return stages;
  const out = trace.outbound;

  stages.push({
    key: "retrieval",
    label: `Retrieval — ${out.retrieval.length} chunks`,
    state: "done",
    render: () =>
      out.retrieval.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          Nothing relevant was retrieved, so no answer was attempted.
        </p>
      ) : (
        <div className="space-y-2">
          {out.retrieval.map((c, i) => (
            <div key={i} className="rounded-md bg-[var(--color-canvas)] p-3 text-xs">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-medium text-[var(--color-accent-soft)]">
                  [{c.citationId ?? i + 1}]
                </span>
                <span className="font-medium">{c.title}</span>
                {c.isNeighbor && (
                  <span className="badge text-[var(--color-muted)]">neighbour</span>
                )}
                <span className="ml-auto tabular-nums text-[var(--color-faint)]">
                  {typeof c.similarity === "number" && `sim ${c.similarity.toFixed(3)} · `}
                  {typeof c.score === "number" && `rrf ${c.score.toFixed(4)}`}
                </span>
              </div>
              <p className="mb-1 text-[var(--color-faint)]">{c.path}</p>
              {c.excerpt && (
                <p className="note-text whitespace-pre-wrap text-[var(--color-muted)]">
                  {c.excerpt.slice(0, 400)}
                  {c.excerpt.length > 400 ? "…" : ""}
                </p>
              )}
            </div>
          ))}
        </div>
      ),
  });

  stages.push({
    key: "draft",
    label: "Draft",
    state: "done",
    render: () => (
      <>
        <p className="mb-2 text-xs text-[var(--color-muted)]">
          {out.generation.provider}/{out.generation.model}
          {out.generation.latencyMs ? ` · ${out.generation.latencyMs}ms` : ""}
          {out.generation.inputTokens
            ? ` · ${out.generation.inputTokens} in / ${out.generation.outputTokens ?? "?"} out`
            : ""}
        </p>
        <pre className="note-text whitespace-pre-wrap rounded-md bg-[var(--color-canvas)] p-3.5">
          {out.bodyMarkdown}
        </pre>
        {out.editedBodyMarkdown && (
          <div className="mt-3">
            <p className="label">Edited before sending</p>
            <pre className="note-text whitespace-pre-wrap rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-canvas)] p-3.5">
              {out.editedBodyMarkdown}
            </pre>
          </div>
        )}
      </>
    ),
  });

  const graded = out.grounding.verdict && out.grounding.verdict !== "skipped";
  if (graded || !running) {
    stages.push({
      key: "grounding",
      label: `Grounding gate — ${out.grounding.verdict ?? "n/a"}${
        out.grounding.score !== null ? ` (${out.grounding.score.toFixed(2)})` : ""
      }`,
      state: "done",
      render: () => (
        <>
          {(out.grounding.rationale || out.grounding.reasoning) && (
            <p className="mb-3 text-sm text-[var(--color-muted)]">
              {out.grounding.rationale || out.grounding.reasoning}
            </p>
          )}
          {out.grounding.claims.length > 0 && (
            <div className="space-y-1.5">
              {out.grounding.claims.map((c, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <span
                    className={`badge mt-0.5 shrink-0 ${
                      c.status === "supported"
                        ? "border-[#1a4d2e] text-[var(--color-ok)]"
                        : c.status === "contradicted"
                          ? "border-[#5c2229] text-[var(--color-bad)]"
                          : "border-[#5c4a1a] text-[var(--color-warn)]"
                    }`}
                  >
                    {c.status}
                  </span>
                  <span className="text-[var(--color-muted)]">
                    {c.claim}
                    {c.note && <span className="block text-xs opacity-70">{c.note}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      ),
    });
  }

  if (trace.reviewActions.length > 0) {
    stages.push({
      key: "review",
      label: "Human review",
      state: "done",
      render: () => (
        <div className="space-y-1.5 text-sm">
          {trace.reviewActions.map((a, i) => (
            <p key={i} className="text-[var(--color-muted)]">
              <span className="text-[var(--color-ink)]">{a.action}</span> by {a.actor} ·{" "}
              {new Date(a.createdAt).toLocaleString()}
              {a.note ? ` — ${a.note}` : ""}
            </p>
          ))}
        </div>
      ),
    });
  }

  const delivered = out.status === "sent" || out.status === "failed" || Boolean(out.error);
  if (delivered || !running) {
    stages.push({
      key: "delivery",
      label: "Delivery",
      state: out.status === "sending" ? "running" : "done",
      render: () =>
        out.status === "sent" ? (
          <>
            <p className="text-sm text-[var(--color-ok)]">
              Delivered {trace.sentAt ? new Date(trace.sentAt).toLocaleString() : ""}
            </p>
            <Field label="Resend message id" value={out.providerMessageId ?? "—"} mono />
          </>
        ) : out.error ? (
          <p className="text-sm text-[var(--color-bad)]">{out.error}</p>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">
            Not delivered — status is <code>{out.status}</code>.
            {out.status === "pending_review" && (
              <>
                {" "}
                <Link
                  href="/dashboard/review"
                  className="text-[var(--color-accent-soft)] underline"
                >
                  Open the review queue
                </Link>
                .
              </>
            )}
          </p>
        ),
    });
  }

  return stages;
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <p className="mt-1 text-xs">
      <span className="text-[var(--color-muted)]">{label}: </span>
      <span className={mono ? "font-mono text-[11px]" : ""}>{value}</span>
    </p>
  );
}
