"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronRight,
  ExternalLink,
  Loader2,
  Pencil,
  X,
} from "lucide-react";
import Link from "next/link";

/**
 * Review queue as a scannable list.
 *
 * Collapsed by default: with several drafts waiting, the useful first view is
 * "who asked what, and how confident was the gate" — not five full drafts
 * stacked vertically. Expanding one shows the draft, the excerpts it was built
 * from, the judge's per-claim verdict, and the actions.
 *
 * Approve and reject apply optimistically. The row leaves the list immediately
 * and only comes back if the server rejects the change, because the outcome is
 * near-certain and waiting on a round trip for every decision makes clearing a
 * queue feel slow.
 */

interface Claim {
  claim: string;
  status: "supported" | "partial" | "unsupported" | "contradicted";
  note?: string;
}

interface RetrievalItem {
  citationId?: string;
  path: string;
  title: string;
  excerpt?: string;
  isNeighbor?: boolean;
}

export interface ReviewDraft {
  id: string;
  subject: string;
  toEmail: string;
  bodyMarkdown: string;
  editedBodyMarkdown: string | null;
  status: string;
  groundingScore: number | null;
  grounding: {
    reasoning?: string;
    rationale?: string;
    claims?: Claim[];
  };
  retrieval: RetrievalItem[];
  question: string | null;
  receivedAt: string | null;
  inboundId: string | null;
}

export default function ReviewQueue({ drafts }: { drafts: ReviewDraft[] }) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Ids removed optimistically, restored if the server disagrees.
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);

  const visible = drafts.filter((d) => !resolved.has(d.id));

  async function act(draft: ReviewDraft, action: "approve" | "reject" | "edit") {
    setBusy(`${draft.id}:${action}`);
    setError("");

    // Approve and reject are terminal, so the row can go straight away.
    const optimistic = action !== "edit";
    if (optimistic) setResolved((prev) => new Set(prev).add(draft.id));

    try {
      const res = await fetch(`/api/review/${draft.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          bodyMarkdown: action === "edit" ? edits[draft.id] : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Action failed.");

      if (action === "edit") setEditing(null);
      router.refresh();
    } catch (e) {
      // Put it back: the queue must never claim something was handled when it
      // was not.
      if (optimistic) {
        setResolved((prev) => {
          const next = new Set(prev);
          next.delete(draft.id);
          return next;
        });
      }
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  if (visible.length === 0) {
    return (
      <div className="card animate-rise-in text-center">
        <p className="font-medium">Nothing waiting</p>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">
          Drafts the grounding gate could not fully verify will appear here.
        </p>
      </div>
    );
  }

  return (
    <>
      {error && <div className="callout callout-bad mb-3 animate-slide-down">{error}</div>}

      <div className="card stagger divide-y divide-[var(--color-border-soft)] p-0">
        {visible.map((draft) => {
          const open = openId === draft.id;
          const body = edits[draft.id] ?? draft.editedBodyMarkdown ?? draft.bodyMarkdown;
          const problems = (draft.grounding.claims ?? []).filter((c) => c.status !== "supported");
          const blocked = draft.status === "blocked";

          return (
            <div key={draft.id}>
              {/* ------------------------------------------------ summary -- */}
              <button
                onClick={() => setOpenId(open ? null : draft.id)}
                aria-expanded={open}
                className="row-hover flex w-full items-center gap-3 px-5 py-3.5 text-left"
              >
                <ChevronRight
                  size={14}
                  className={`shrink-0 text-[var(--color-muted)] transition-transform duration-200 ${
                    open ? "rotate-90" : ""
                  }`}
                />

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{draft.subject}</p>
                  <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">
                    {draft.toEmail}
                    {draft.question ? ` — ${draft.question}` : ""}
                  </p>
                </div>

                {draft.receivedAt && (
                  <span className="hidden shrink-0 text-xs text-[var(--color-muted)] sm:block">
                    {new Date(draft.receivedAt).toLocaleDateString()}
                  </span>
                )}

                <span
                  className={`badge shrink-0 ${
                    blocked
                      ? "border-[#5c2229] text-[var(--color-bad)]"
                      : "border-[#5c4a1a] text-[var(--color-warn)]"
                  }`}
                >
                  {blocked ? "blocked" : "review"}
                  {draft.groundingScore !== null && ` · ${draft.groundingScore.toFixed(2)}`}
                </span>
              </button>

              {/* ------------------------------------------------- detail -- */}
              {open && (
                <div className="animate-slide-down border-t border-[var(--color-border-soft)] bg-[var(--color-canvas)]/40 px-5 py-4">
                  {draft.question && (
                    <div className="mb-3">
                      <p className="label">Question asked</p>
                      <p className="text-sm text-[var(--color-muted)]">{draft.question}</p>
                    </div>
                  )}

                  <div className="mb-1.5 flex items-center justify-between">
                    <p className="label mb-0">Drafted reply</p>
                    <div className="flex items-center gap-3">
                      {draft.inboundId && (
                        <Link
                          href={`/dashboard/traces/${draft.inboundId}`}
                          className="flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                        >
                          <ExternalLink size={11} /> Full trace
                        </Link>
                      )}
                      {!blocked && (
                        <button
                          onClick={() => setEditing(editing === draft.id ? null : draft.id)}
                          className="flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                        >
                          <Pencil size={11} />
                          {editing === draft.id ? "Cancel" : "Edit"}
                        </button>
                      )}
                    </div>
                  </div>

                  {editing === draft.id ? (
                    <>
                      <textarea
                        value={body}
                        onChange={(e) =>
                          setEdits((prev) => ({ ...prev, [draft.id]: e.target.value }))
                        }
                        rows={9}
                        className="input note-text"
                      />
                      <button
                        onClick={() => act(draft, "edit")}
                        disabled={busy !== null}
                        className="btn-ghost press mt-2 text-xs"
                      >
                        {busy === `${draft.id}:edit` && (
                          <Loader2 size={12} className="animate-spin" />
                        )}
                        Save edit
                      </button>
                    </>
                  ) : (
                    <pre className="note-text whitespace-pre-wrap rounded-md bg-[var(--color-canvas)] p-3.5">
                      {body}
                    </pre>
                  )}

                  {(draft.grounding.rationale || draft.grounding.reasoning) && (
                    <div className="callout callout-warn mt-3">
                      {draft.grounding.rationale || draft.grounding.reasoning}
                    </div>
                  )}

                  {problems.length > 0 && (
                    <div className="mt-3">
                      <p className="label">Claims to verify</p>
                      <ul className="space-y-1.5">
                        {problems.map((c, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm">
                            <span
                              className={`badge mt-0.5 shrink-0 ${
                                c.status === "contradicted"
                                  ? "border-[#5c2229] text-[var(--color-bad)]"
                                  : "border-[#5c4a1a] text-[var(--color-warn)]"
                              }`}
                            >
                              {c.status}
                            </span>
                            <span className="text-[var(--color-muted)]">
                              {c.claim}
                              {c.note && (
                                <span className="block text-xs opacity-70">{c.note}</span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {draft.retrieval.length > 0 && (
                    <details className="mt-3 group">
                      <summary className="cursor-pointer list-none text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]">
                        <ChevronRight
                          size={12}
                          className="mr-1 inline transition-transform group-open:rotate-90"
                        />
                        {draft.retrieval.length} retrieved excerpts
                      </summary>
                      <div className="mt-2 space-y-2">
                        {draft.retrieval.map((item, i) => (
                          <div key={i} className="rounded-md bg-[var(--color-canvas)] p-3 text-xs">
                            <p className="mb-1 font-medium">
                              <span className="text-[var(--color-accent-soft)]">
                                [{item.citationId ?? "?"}]
                              </span>{" "}
                              {item.title}
                              {item.isNeighbor && (
                                <span className="ml-1.5 text-[var(--color-muted)]">
                                  (neighbour)
                                </span>
                              )}
                            </p>
                            <p className="mb-1.5 text-[var(--color-faint)]">{item.path}</p>
                            <p className="note-text whitespace-pre-wrap text-[var(--color-muted)]">
                              {item.excerpt}
                            </p>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  <div className="mt-4 flex gap-2 border-t border-[var(--color-border-soft)] pt-3.5">
                    <button
                      onClick={() => act(draft, "approve")}
                      disabled={busy !== null}
                      className="btn-primary press text-xs"
                    >
                      {busy === `${draft.id}:approve` ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Check size={13} />
                      )}
                      Approve and send
                    </button>
                    <button
                      onClick={() => act(draft, "reject")}
                      disabled={busy !== null}
                      className="btn-danger press text-xs"
                    >
                      {busy === `${draft.id}:reject` ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <X size={13} />
                      )}
                      Reject
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
