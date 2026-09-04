"use client";

import { useState } from "react";
import { Loader2, Search, Send } from "lucide-react";

interface Chunk {
  citationId?: string;
  path: string;
  title: string;
  content: string;
  score: number;
  similarity: number | null;
  ftsScore: number | null;
  isNeighbor?: boolean;
  tokenCount: number;
}

interface QueryResponse {
  answer?: string;
  noContext?: boolean;
  queries?: string[];
  chunks?: Chunk[];
  contextTokens?: number;
  grounding?: { score: number; verdict: string; reasoning: string } | null;
  gate?: { action: string; rationale: string } | null;
  generation?: { provider: string; model: string; latencyMs: number };
  timings?: { embedMs: number; searchMs: number; rerankMs: number; totalMs: number };
  error?: string;
}

/**
 * Retrieval and answering playground.
 *
 * The fast loop for tuning: ask a question, see the expanded queries, the exact
 * chunks that came back with their scores, the draft, and the gate's decision —
 * without sending anything. "Retrieve only" skips generation so retrieval
 * parameters can be tuned without paying for a completion each time.
 */
export default function PlaygroundPage() {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [error, setError] = useState("");

  async function ask(retrieveOnly: boolean) {
    if (!question.trim()) return;

    setBusy(true);
    setError("");
    setResult(null);

    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: question.trim(), retrieveOnly }),
      });
      const json = (await res.json()) as QueryResponse;
      if (!res.ok) throw new Error(json.error ?? "Query failed.");
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Query failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Playground</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Runs the real answering path against the default vault. Nothing is emailed.
        </p>
      </header>

      <div className="card">
        <label className="label" htmlFor="question">
          Question
        </label>
        <textarea
          id="question"
          rows={3}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void ask(false);
          }}
          placeholder="Ask the vault something, the way someone would email it…"
          className="input resize-y"
        />

        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => ask(false)} disabled={busy || !question.trim()} className="btn-primary">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            Ask
          </button>
          <button onClick={() => ask(true)} disabled={busy || !question.trim()} className="btn-ghost">
            <Search size={14} />
            Retrieve only
          </button>
          <span className="self-center text-xs text-[var(--color-muted)]">⌘/Ctrl + Enter</span>
        </div>
      </div>

      {error && (
        <div className="card mt-4 border-[#5c2a2a]">
          <p className="text-sm text-[var(--color-bad)]">{error}</p>
        </div>
      )}

      {result && (
        <>
          {result.answer !== undefined && (
            <div className="card mt-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-medium">Answer</h2>
                {result.gate && (
                  <span
                    className={`badge ${
                      result.gate.action === "send"
                        ? "border-[#1f4d2a] bg-[#12261a] text-[var(--color-ok)]"
                        : result.gate.action === "review"
                          ? "border-[#5c4a1a] bg-[#241f10] text-[var(--color-warn)]"
                          : "border-[#5c2a2a] bg-[#2a1516] text-[var(--color-bad)]"
                    }`}
                  >
                    {result.gate.action}
                    {result.grounding ? ` · ${result.grounding.score.toFixed(2)}` : ""}
                  </span>
                )}
              </div>

              {result.noContext ? (
                <p className="text-sm text-[var(--color-muted)]">
                  Nothing relevant was retrieved. The sender would get the not-found reply.
                </p>
              ) : (
                <div className="whitespace-pre-wrap rounded-lg bg-[var(--color-canvas)] p-3.5 text-sm leading-relaxed">
                  {result.answer}
                </div>
              )}

              {result.gate && (
                <p className="mt-3 text-xs text-[var(--color-muted)]">{result.gate.rationale}</p>
              )}
            </div>
          )}

          <div className="card mt-4">
            <h2 className="mb-3 font-medium">Retrieval</h2>

            {result.queries && result.queries.length > 1 && (
              <div className="mb-4">
                <p className="label">Expanded queries</p>
                <ul className="space-y-1 text-sm text-[var(--color-muted)]">
                  {result.queries.map((q, i) => (
                    <li key={i}>
                      {i === 0 ? "original: " : `variant ${i}: `}
                      {q}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
              <span>{result.chunks?.length ?? 0} chunks</span>
              <span>{result.contextTokens ?? 0} context tokens</span>
              {result.timings && (
                <>
                  <span>embed {result.timings.embedMs}ms</span>
                  <span>search {result.timings.searchMs}ms</span>
                  {result.timings.rerankMs > 0 && <span>rerank {result.timings.rerankMs}ms</span>}
                </>
              )}
              {result.generation && (
                <span>
                  {result.generation.provider}/{result.generation.model} ·{" "}
                  {result.generation.latencyMs}ms
                </span>
              )}
            </div>

            <div className="space-y-2">
              {(result.chunks ?? []).map((chunk, i) => (
                <div key={i} className="rounded-lg bg-[var(--color-canvas)] p-3 text-xs">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <span className="font-medium text-[var(--color-accent)]">
                      [{chunk.citationId ?? i + 1}]
                    </span>
                    <span className="font-medium">{chunk.title}</span>
                    {chunk.isNeighbor && (
                      <span className="badge border-[var(--color-border)] text-[var(--color-muted)]">
                        neighbour
                      </span>
                    )}
                    <span className="ml-auto tabular-nums text-[var(--color-muted)]">
                      {chunk.similarity !== null && `sim ${chunk.similarity.toFixed(3)} · `}
                      rrf {chunk.score.toFixed(4)} · {chunk.tokenCount}t
                    </span>
                  </div>
                  <p className="mb-1.5 text-[var(--color-muted)]">{chunk.path}</p>
                  <p className="whitespace-pre-wrap text-[var(--color-muted)]">
                    {chunk.content.slice(0, 500)}
                    {chunk.content.length > 500 ? "…" : ""}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {result.grounding && (
            <div className="card mt-4">
              <h2 className="mb-2 font-medium">Grounding check</h2>
              <p className="text-sm text-[var(--color-muted)]">{result.grounding.reasoning}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
