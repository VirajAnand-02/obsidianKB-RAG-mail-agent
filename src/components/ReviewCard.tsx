"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Loader2, Pencil, X } from "lucide-react";

interface Claim {
  claim: string;
  status: "supported" | "partial" | "unsupported" | "contradicted";
  citedIds?: string[];
  note?: string;
}

interface RetrievalItem {
  citationId?: string;
  path: string;
  title: string;
  score?: number;
  excerpt?: string;
  isNeighbor?: boolean;
}

/**
 * One draft awaiting a decision.
 *
 * Shows the judge's per-claim breakdown rather than only its score: "0.62" does
 * not tell a reviewer what to check, whereas "this sentence is unsupported"
 * points straight at the thing to verify.
 */
export default function ReviewCard({ draft }: { draft: Record<string, unknown> }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(
    (draft.edited_body_markdown as string) || (draft.body_markdown as string) || "",
  );
  const [showSources, setShowSources] = useState(false);

  const inbound = draft.inbound_emails as Record<string, unknown> | null;
  const grounding = (draft.grounding ?? {}) as {
    reasoning?: string;
    rationale?: string;
    claims?: Claim[];
    hallucinationRisk?: string;
  };
  const retrieval = (draft.retrieval ?? []) as RetrievalItem[];
  const score = draft.grounding_score as number | null;
  const isBlocked = draft.status === "blocked";

  async function act(action: "approve" | "reject" | "edit") {
    setBusy(action);
    setError("");

    try {
      const res = await fetch(`/api/review/${draft.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, bodyMarkdown: action === "edit" ? body : undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Action failed.");

      if (action === "edit") setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  const problemClaims = (grounding.claims ?? []).filter((c) => c.status !== "supported");

  return (
    <div className="card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border)] pb-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{draft.subject as string}</p>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            to {draft.to_email as string}
            {inbound?.received_at
              ? ` · received ${new Date(inbound.received_at as string).toLocaleString()}`
              : ""}
          </p>
        </div>

        <span
          className={`badge shrink-0 ${
            isBlocked
              ? "border-[#5c2a2a] bg-[#2a1516] text-[var(--color-bad)]"
              : "border-[#5c4a1a] bg-[#241f10] text-[var(--color-warn)]"
          }`}
        >
          {isBlocked ? "blocked" : "review"} · {score !== null ? score.toFixed(2) : "n/a"}
        </span>
      </div>

      {inbound?.question ? (
        <div className="mt-3">
          <p className="label">Question asked</p>
          <p className="text-sm text-[var(--color-muted)]">{inbound.question as string}</p>
        </div>
      ) : null}

      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between">
          <p className="label mb-0">Drafted reply</p>
          {!isBlocked && (
            <button
              onClick={() => setEditing((v) => !v)}
              className="text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            >
              <Pencil size={11} className="mr-1 inline" />
              {editing ? "Cancel edit" : "Edit"}
            </button>
          )}
        </div>

        {editing ? (
          <>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="input font-mono text-[13px] leading-relaxed"
            />
            <button
              onClick={() => act("edit")}
              disabled={busy !== null}
              className="btn-ghost mt-2 text-xs"
            >
              {busy === "edit" ? <Loader2 size={13} className="animate-spin" /> : null}
              Save edit
            </button>
          </>
        ) : (
          <div className="whitespace-pre-wrap rounded-lg bg-[var(--color-canvas)] p-3.5 text-sm leading-relaxed">
            {body}
          </div>
        )}
      </div>

      {(grounding.rationale || grounding.reasoning) && (
        <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
          <p className="label mb-1">Why it was held</p>
          <p className="text-sm text-[var(--color-muted)]">
            {grounding.rationale || grounding.reasoning}
          </p>
        </div>
      )}

      {problemClaims.length > 0 && (
        <div className="mt-3">
          <p className="label">Claims to verify</p>
          <ul className="space-y-1.5">
            {problemClaims.map((claim, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span
                  className={`badge mt-0.5 shrink-0 ${
                    claim.status === "contradicted"
                      ? "border-[#5c2a2a] bg-[#2a1516] text-[var(--color-bad)]"
                      : "border-[#5c4a1a] bg-[#241f10] text-[var(--color-warn)]"
                  }`}
                >
                  {claim.status}
                </span>
                <span className="text-[var(--color-muted)]">
                  {claim.claim}
                  {claim.note && <span className="block text-xs opacity-70">{claim.note}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {retrieval.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setShowSources((v) => !v)}
            className="flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
          >
            <ChevronDown
              size={13}
              className={`transition-transform ${showSources ? "" : "-rotate-90"}`}
            />
            {retrieval.length} retrieved excerpts
          </button>

          {showSources && (
            <div className="mt-2 space-y-2">
              {retrieval.map((item, i) => (
                <div key={i} className="rounded-lg bg-[var(--color-canvas)] p-3 text-xs">
                  <p className="mb-1 font-medium">
                    <span className="text-[var(--color-accent)]">[{item.citationId ?? "?"}]</span>{" "}
                    {item.title}
                    {item.isNeighbor && (
                      <span className="ml-1.5 text-[var(--color-muted)]">(neighbour)</span>
                    )}
                  </p>
                  <p className="mb-1.5 text-[var(--color-muted)]">{item.path}</p>
                  <p className="whitespace-pre-wrap text-[var(--color-muted)]">{item.excerpt}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-[var(--color-bad)]">{error}</p>}

      <div className="mt-4 flex gap-2 border-t border-[var(--color-border)] pt-4">
        <button
          onClick={() => act("approve")}
          disabled={busy !== null}
          className="btn-primary text-sm"
        >
          {busy === "approve" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Check size={14} />
          )}
          Approve and send
        </button>

        <button onClick={() => act("reject")} disabled={busy !== null} className="btn-danger text-sm">
          {busy === "reject" ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
          Reject
        </button>
      </div>
    </div>
  );
}
