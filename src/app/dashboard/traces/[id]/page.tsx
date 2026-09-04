import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { getTrace, type TraceDetail } from "@/lib/traces";
import OutcomeBadge from "@/components/OutcomeBadge";
import CollapsibleJson from "@/components/CollapsibleJson";

export const dynamic = "force-dynamic";

/**
 * One message, end to end.
 *
 * Laid out as the pipeline runs it — received, filtered, retrieved, drafted,
 * judged, delivered — so a surprising outcome can be read top to bottom rather
 * than reconstructed from several tables.
 */
export default async function TraceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const trace = await getTrace(id);
  if (!trace) notFound();

  return (
    <div className="pb-12">
      <Link
        href="/dashboard/traces"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-ink)]"
      >
        <ArrowLeft size={14} /> All traces
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{trace.subject || "(no subject)"}</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            from {trace.fromEmail}
            {trace.toEmail ? ` → ${trace.toEmail}` : ""} ·{" "}
            {new Date(trace.receivedAt).toLocaleString()}
            {trace.durationMs !== null && ` · answered in ${(trace.durationMs / 1000).toFixed(1)}s`}
          </p>
        </div>
        <OutcomeBadge outcome={trace.outcome} score={trace.groundingScore} />
      </header>

      <ol className="relative space-y-4 border-l border-[var(--color-border)] pl-6">
        <Step n={1} label="Received">
          <Field label="Message-ID" value={trace.messageId ?? "—"} mono />
          {trace.textBody && (
            <div className="mt-3">
              <p className="label">Raw body</p>
              <pre className="whitespace-pre-wrap rounded-lg bg-[var(--color-canvas)] p-3 text-xs text-[var(--color-muted)]">
                {trace.textBody.slice(0, 1500)}
                {trace.textBody.length > 1500 ? "\n…" : ""}
              </pre>
            </div>
          )}
        </Step>

        <Step n={2} label="Triage">
          {trace.inboundStatus === "ignored" ? (
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
                  <p className="rounded-lg bg-[var(--color-canvas)] p-3 text-sm">{trace.question}</p>
                </div>
              )}
            </>
          )}
        </Step>

        {trace.outbound ? (
          <>
            <Step n={3} label={`Retrieval — ${trace.outbound.retrieval.length} chunks`}>
              {trace.outbound.retrieval.length === 0 ? (
                <p className="text-sm text-[var(--color-muted)]">
                  Nothing relevant was retrieved, so no answer was attempted.
                </p>
              ) : (
                <div className="space-y-2">
                  {trace.outbound.retrieval.map((c, i) => (
                    <div key={i} className="rounded-lg bg-[var(--color-canvas)] p-3 text-xs">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className="font-medium text-[var(--color-accent)]">
                          [{c.citationId ?? i + 1}]
                        </span>
                        <span className="font-medium">{c.title}</span>
                        {c.isNeighbor && (
                          <span className="badge border-[var(--color-border)] text-[var(--color-muted)]">
                            neighbour
                          </span>
                        )}
                        <span className="ml-auto tabular-nums text-[var(--color-muted)]">
                          {typeof c.similarity === "number" && `sim ${c.similarity.toFixed(3)} · `}
                          {typeof c.score === "number" && `rrf ${c.score.toFixed(4)}`}
                        </span>
                      </div>
                      <p className="mb-1 text-[var(--color-muted)]">{c.path}</p>
                      {c.excerpt && (
                        <p className="whitespace-pre-wrap text-[var(--color-muted)]">
                          {c.excerpt.slice(0, 400)}
                          {c.excerpt.length > 400 ? "…" : ""}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Step>

            <Step n={4} label="Draft">
              <p className="mb-2 text-xs text-[var(--color-muted)]">
                {trace.outbound.generation.provider}/{trace.outbound.generation.model}
                {trace.outbound.generation.latencyMs
                  ? ` · ${trace.outbound.generation.latencyMs}ms`
                  : ""}
                {trace.outbound.generation.inputTokens
                  ? ` · ${trace.outbound.generation.inputTokens} in / ${trace.outbound.generation.outputTokens ?? "?"} out`
                  : ""}
              </p>
              <pre className="whitespace-pre-wrap rounded-lg bg-[var(--color-canvas)] p-3.5 text-sm leading-relaxed">
                {trace.outbound.bodyMarkdown}
              </pre>

              {trace.outbound.editedBodyMarkdown && (
                <div className="mt-3">
                  <p className="label">Edited before sending</p>
                  <pre className="whitespace-pre-wrap rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-canvas)] p-3.5 text-sm leading-relaxed">
                    {trace.outbound.editedBodyMarkdown}
                  </pre>
                </div>
              )}
            </Step>

            <Step
              n={5}
              label={`Grounding gate — ${trace.outbound.grounding.verdict ?? "n/a"}${
                trace.outbound.grounding.score !== null
                  ? ` (${trace.outbound.grounding.score.toFixed(2)})`
                  : ""
              }`}
            >
              {(trace.outbound.grounding.rationale || trace.outbound.grounding.reasoning) && (
                <p className="mb-3 text-sm text-[var(--color-muted)]">
                  {trace.outbound.grounding.rationale || trace.outbound.grounding.reasoning}
                </p>
              )}

              {trace.outbound.grounding.claims.length > 0 && (
                <div className="space-y-1.5">
                  {trace.outbound.grounding.claims.map((c, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <span
                        className={`badge mt-0.5 shrink-0 ${
                          c.status === "supported"
                            ? "border-[#1f4d2a] bg-[#12261a] text-[var(--color-ok)]"
                            : c.status === "contradicted"
                              ? "border-[#5c2a2a] bg-[#2a1516] text-[var(--color-bad)]"
                              : "border-[#5c4a1a] bg-[#241f10] text-[var(--color-warn)]"
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
            </Step>

            {trace.reviewActions.length > 0 && (
              <Step n={6} label="Human review">
                <div className="space-y-1.5 text-sm">
                  {trace.reviewActions.map((a, i) => (
                    <p key={i} className="text-[var(--color-muted)]">
                      <span className="text-[var(--color-ink)]">{a.action}</span> by {a.actor} ·{" "}
                      {new Date(a.createdAt).toLocaleString()}
                      {a.note ? ` — ${a.note}` : ""}
                    </p>
                  ))}
                </div>
              </Step>
            )}

            <Step n={trace.reviewActions.length > 0 ? 7 : 6} label="Delivery">
              {trace.outbound.status === "sent" ? (
                <>
                  <p className="text-sm text-[var(--color-ok)]">
                    Delivered {trace.sentAt ? new Date(trace.sentAt).toLocaleString() : ""}
                  </p>
                  <Field
                    label="Resend message id"
                    value={trace.outbound.providerMessageId ?? "—"}
                    mono
                  />
                </>
              ) : trace.outbound.error ? (
                <p className="text-sm text-[var(--color-bad)]">{trace.outbound.error}</p>
              ) : (
                <p className="text-sm text-[var(--color-muted)]">
                  Not delivered — status is <code>{trace.outbound.status}</code>.
                  {trace.outbound.status === "pending_review" && (
                    <>
                      {" "}
                      <Link href="/dashboard/review" className="text-[var(--color-accent)] underline">
                        Open the review queue
                      </Link>
                      .
                    </>
                  )}
                </p>
              )}
            </Step>
          </>
        ) : (
          <Step n={3} label="No reply generated">
            <p className="text-sm text-[var(--color-muted)]">
              The pipeline stopped before drafting, so there is nothing further to show.
            </p>
          </Step>
        )}
      </ol>

      <div className="mt-8">
        <CollapsibleJson label="Raw webhook payload" value={trace.raw} />
      </div>
    </div>
  );
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <li className="relative">
      <span className="absolute -left-[31px] flex h-5 w-5 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[10px] text-[var(--color-muted)]">
        {n}
      </span>
      <div className="card">
        <h2 className="mb-3 text-sm font-medium">{label}</h2>
        {children}
      </div>
    </li>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <p className="mt-1 text-xs">
      <span className="text-[var(--color-muted)]">{label}: </span>
      <span className={mono ? "font-mono text-[11px]" : ""}>{value}</span>
    </p>
  );
}
