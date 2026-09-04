import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const METRIC_LABELS: Record<string, string> = {
  groundedness: "Grounded",
  citationValidity: "Citations",
  answerRelevance: "Relevance",
  correctness: "Correct",
  contextRecall: "Recall",
  refusalCorrectness: "Refusal",
  tone: "Tone",
};

function scoreColour(value: number | null | undefined): string {
  if (typeof value !== "number") return "text-[var(--color-muted)]";
  if (value >= 0.8) return "text-[var(--color-ok)]";
  if (value >= 0.6) return "text-[var(--color-warn)]";
  return "text-[var(--color-bad)]";
}

/**
 * Evaluation history.
 *
 * Runs are listed with the prompt version and configuration that produced them,
 * because a score is only meaningful next to what it was measuring.
 */
export default async function EvalsPage() {
  const db = supabaseAdmin();

  const { data: runs } = await db
    .from("eval_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(20);

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Evaluations</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Run with <code className="text-[var(--color-ink)]">npm run eval</code>. Add{" "}
          <code>--compare &lt;report.json&gt;</code> to diff against a previous run.
        </p>
      </header>

      {(runs ?? []).length === 0 ? (
        <div className="card">
          <p className="font-medium">No evaluation runs yet</p>
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">
            Copy <code>src/evaluator/datasets/golden.example.jsonl</code> to{" "}
            <code>golden.jsonl</code>, replace the cases with questions your vault should answer,
            then run <code className="text-[var(--color-ink)]">npm run eval</code>.
          </p>
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            Include cases you expect to fail — a set of only easy questions scores 0.95 and tells
            you nothing.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {(runs ?? []).map((run) => {
            const summary = (run.summary ?? {}) as Record<string, number | null>;
            const config = (run.config ?? {}) as Record<string, Record<string, unknown>>;
            const overall = summary.overall;

            return (
              <div key={run.id as string} className="card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{run.name as string}</p>
                    <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                      {run.prompt_name as string} v{run.prompt_version as string} ·{" "}
                      {config.llm?.provider as string}/{config.llm?.model as string} · topK=
                      {String(config.retrieval?.topK ?? "?")} · rerank=
                      {String(config.retrieval?.reranker ?? "none")}
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className={`text-xl font-semibold tabular-nums ${scoreColour(overall)}`}>
                      {typeof overall === "number" ? overall.toFixed(3) : "—"}
                    </p>
                    <p className="text-xs text-[var(--color-muted)]">
                      {run.passed_cases as number}/{run.total_cases as number} passed
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-[var(--color-border)] pt-3">
                  {Object.entries(METRIC_LABELS).map(([key, label]) => {
                    const value = summary[key];
                    if (value === undefined) return null;
                    return (
                      <div key={key}>
                        <p className="text-xs text-[var(--color-muted)]">{label}</p>
                        <p className={`text-sm font-medium tabular-nums ${scoreColour(value)}`}>
                          {typeof value === "number" ? value.toFixed(2) : "—"}
                        </p>
                      </div>
                    );
                  })}
                </div>

                {run.status === "failed" && (
                  <p className="mt-2 text-xs text-[var(--color-bad)]">{run.error as string}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
