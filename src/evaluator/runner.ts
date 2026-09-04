import { readFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";

import { env } from "@/lib/env";
import { appConfig } from "@/lib/app-config";
import { getRuntimeConfig } from "@/lib/config";
import { answerQuestion } from "@/lib/agents/answer";
import { retrieve } from "@/lib/rag/retrieve";
import { loadPrompt } from "@/lib/prompts";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getWorkspaceId, requireDefaultVaultId } from "@/lib/workspace";
import { createLogger, errorMessage } from "@/lib/logger";
import type { EvalCase, EvalCaseResult, EvalScores } from "@/lib/types";

import { retrievalMetrics } from "@/evaluator/metrics/retrieval";
import { generationMetrics } from "@/evaluator/metrics/generation";
import {
  judgeAnswerQuality,
  judgeGroundedness,
  judgeRetrievalRelevance,
  judgeTone,
} from "@/evaluator/judge";

const log = createLogger("eval:runner");

/**
 * The evaluation harness.
 *
 * Runs a golden set of questions through the real answering path, scores each
 * answer on several independent axes, and records the run against the exact
 * prompt version and configuration that produced it.
 *
 * The reason to record configuration alongside the score is that this is a
 * comparison tool, not a certification: "0.78" means nothing on its own, but
 * "0.78 with reranking vs 0.71 without" is a decision.
 */

/**
 * Weights for the composite score.
 *
 * Groundedness dominates deliberately. For a system that emails strangers on
 * your behalf, an ungrounded answer is a worse outcome than a slightly
 * unhelpful one, and the weighting should say so.
 */
export const DEFAULT_WEIGHTS: Record<keyof EvalScores, number> = {
  groundedness: 0.3,
  citationValidity: 0.15,
  answerRelevance: 0.15,
  correctness: 0.15,
  contextRecall: 0.1,
  refusalCorrectness: 0.1,
  tone: 0.05,
  contextPrecision: 0,
};

export interface RunOptions {
  dataset?: string;
  vaultId?: string;
  name?: string;
  promptName?: string;
  concurrency?: number;
  repeats?: number;
  passThreshold?: number;
  /** Skip the LLM judges and report only deterministic metrics. */
  fastMode?: boolean;
  /** Filter to cases carrying any of these tags. */
  tags?: string[];
  /** Do not write the run to the database. */
  noPersist?: boolean;
  onCaseComplete?: (result: EvalCaseResult, index: number, total: number) => void;
}

export interface RunSummary {
  runId: string | null;
  name: string;
  dataset: string;
  promptName: string;
  promptVersion: string;
  promptHash: string;
  config: Record<string, unknown>;
  results: EvalCaseResult[];
  metrics: Record<string, number | null>;
  totalCases: number;
  passedCases: number;
  overall: number;
  passed: boolean;
  durationMs: number;
}

/** Reads a JSONL (or JSON array) dataset of evaluation cases. */
export async function loadDataset(datasetPath: string): Promise<EvalCase[]> {
  const absolute = path.isAbsolute(datasetPath)
    ? datasetPath
    : path.join(process.cwd(), datasetPath);

  let raw: string;
  try {
    raw = await readFile(absolute, "utf8");
  } catch {
    throw new Error(
      `Dataset not found at ${absolute}. Copy src/evaluator/datasets/golden.example.jsonl ` +
        `to golden.jsonl and fill it with questions your vault should answer.`,
    );
  }

  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`Dataset ${absolute} is empty.`);

  // Accept both a JSON array and JSONL, since hand-edited files end up as both.
  const cases: EvalCase[] = trimmed.startsWith("[")
    ? JSON.parse(trimmed)
    : trimmed
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("//") && !line.startsWith("#"))
        .map((line, i) => {
          try {
            return JSON.parse(line) as EvalCase;
          } catch (e) {
            throw new Error(`Dataset line ${i + 1} is not valid JSON: ${errorMessage(e)}`);
          }
        });

  cases.forEach((c, i) => {
    if (!c.question?.trim()) throw new Error(`Case ${c.id ?? i + 1} has no question.`);
    if (!c.id) c.id = `case-${i + 1}`;
  });

  return cases;
}

/** Averages the defined values, ignoring nulls. */
function mean(values: (number | null | undefined)[]): number | null {
  const defined = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (defined.length === 0) return null;
  return defined.reduce((a, b) => a + b, 0) / defined.length;
}

/**
 * Weighted composite of the available scores.
 * Missing metrics are dropped and the remaining weights renormalised, so a case
 * without a reference answer is not penalised for lacking a correctness score.
 */
export function compositeScore(
  scores: EvalScores,
  weights: Record<string, number> = DEFAULT_WEIGHTS,
): number {
  let total = 0;
  let weightSum = 0;

  for (const [key, weight] of Object.entries(weights)) {
    const value = scores[key as keyof EvalScores];
    if (typeof value !== "number" || !Number.isFinite(value) || weight === 0) continue;
    total += value * weight;
    weightSum += weight;
  }

  return weightSum === 0 ? 0 : total / weightSum;
}

async function runCase(
  evalCase: EvalCase,
  repeatIndex: number,
  options: RunOptions,
  vaultId: string,
  workspaceId: string,
): Promise<EvalCaseResult> {
  const startedAt = Date.now();

  try {
    const retrieval = await retrieve({ vaultId, query: evalCase.question });

    const answer = await answerQuestion({
      vaultId,
      question: evalCase.question,
      retrieval,
      source: "eval",
      workspaceId,
      promptName: options.promptName,
      senderEmail: "evaluator@localhost",
      subject: evalCase.question.slice(0, 60),
    });

    const answerText = answer.noContext
      ? "The notes do not contain anything covering this question."
      : answer.bodyMarkdown;

    // ---- deterministic metrics (free, always run) --------------------------
    const retrievalScores = retrievalMetrics(retrieval.chunks, evalCase.expectedSources ?? []);
    const generationScores = generationMetrics(
      answerText,
      retrieval.chunks,
      evalCase.shouldRefuse ?? false,
    );

    // ---- judged metrics ----------------------------------------------------
    const [groundedness, quality, tone, relevance] = options.fastMode
      ? [null, null, null, null]
      : await Promise.all([
          judgeGroundedness({
            question: evalCase.question,
            answer: answerText,
            context: retrieval.contextBlock,
          }),
          judgeAnswerQuality({
            question: evalCase.question,
            answer: answerText,
            expected: evalCase.expected,
          }),
          judgeTone({ question: evalCase.question, answer: answerText }),
          judgeRetrievalRelevance({ question: evalCase.question, chunks: retrieval.chunks }),
        ]);

    const scores: EvalScores = {
      groundedness: groundedness?.score ?? undefined,
      answerRelevance: quality?.answerRelevance,
      correctness: quality?.correctness ?? undefined,
      tone: tone?.tone,
      citationValidity: generationScores.citationValidity,
      contextRecall: retrievalScores.contextRecall ?? undefined,
      contextPrecision: retrievalScores.contextPrecision ?? undefined,
      refusalCorrectness: generationScores.refusalCorrectness,
    };

    const overall = compositeScore(scores);
    const threshold = options.passThreshold ?? appConfig.evaluator.passThreshold;

    return {
      caseId: evalCase.id,
      repeatIndex,
      question: evalCase.question,
      expected: evalCase.expected,
      answer: answerText,
      retrieval: retrieval.chunks,
      scores,
      judge: {
        groundedness,
        quality,
        tone,
        relevance,
        deterministic: { ...retrievalScores, ...generationScores },
      },
      overall,
      passed: overall >= threshold,
      latencyMs: Date.now() - startedAt,
      inputTokens: answer.generation.inputTokens,
      outputTokens: answer.generation.outputTokens,
    } as EvalCaseResult;
  } catch (e) {
    return {
      caseId: evalCase.id,
      repeatIndex,
      question: evalCase.question,
      expected: evalCase.expected,
      answer: "",
      retrieval: [],
      scores: {},
      judge: {},
      overall: 0,
      passed: false,
      latencyMs: Date.now() - startedAt,
      error: errorMessage(e),
    };
  }
}

export async function runEvaluation(options: RunOptions = {}): Promise<RunSummary> {
  const startedAt = Date.now();
  const config = await getRuntimeConfig();

  const datasetPath = options.dataset ?? appConfig.evaluator.dataset;
  const allCases = await loadDataset(datasetPath);

  const cases = options.tags?.length
    ? allCases.filter((c) => c.tags?.some((t) => options.tags!.includes(t)))
    : allCases;

  if (cases.length === 0) {
    throw new Error(
      options.tags?.length
        ? `No cases matched tags: ${options.tags.join(", ")}`
        : "The dataset contains no cases.",
    );
  }

  const vaultId = options.vaultId ?? (await requireDefaultVaultId());
  const workspaceId = await getWorkspaceId();
  const promptName = options.promptName ?? "senderAgent";
  const prompt = await loadPrompt(promptName);

  const repeats = Math.max(1, options.repeats ?? appConfig.evaluator.repeats);
  const concurrency = Math.max(1, options.concurrency ?? appConfig.evaluator.concurrency);
  const name = options.name ?? `${promptName} v${prompt.version} @ ${new Date().toISOString()}`;

  // The full configuration is snapshotted so a score can be traced back to the
  // exact retrieval and model settings that produced it.
  const runConfig = {
    llm: config.llm,
    embedding: config.embedding,
    chunking: config.chunking,
    retrieval: config.retrieval,
    grounding: { enabled: config.grounding.enabled },
    fastMode: options.fastMode ?? false,
    repeats,
  };

  log.info("Starting evaluation", {
    dataset: datasetPath,
    cases: cases.length,
    repeats,
    prompt: `${promptName}@${prompt.version}`,
  });

  let runId: string | null = null;
  if (!options.noPersist) {
    const { data, error } = await supabaseAdmin()
      .from("eval_runs")
      .insert({
        workspace_id: workspaceId,
        vault_id: vaultId,
        name,
        dataset: datasetPath,
        prompt_name: promptName,
        prompt_version: prompt.version,
        prompt_hash: prompt.hash,
        config: runConfig,
        total_cases: cases.length * repeats,
        status: "running",
      })
      .select("id")
      .single();

    if (error) log.warn("Could not record the eval run", { error: error.message });
    else runId = data.id as string;
  }

  const limit = pLimit(concurrency);
  const jobs: Promise<EvalCaseResult>[] = [];
  const total = cases.length * repeats;
  let completed = 0;

  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const evalCase of cases) {
      jobs.push(
        limit(async () => {
          const result = await runCase(evalCase, repeat, options, vaultId, workspaceId);
          options.onCaseComplete?.(result, ++completed, total);
          return result;
        }),
      );
    }
  }

  const results = await Promise.all(jobs);

  const metrics: Record<string, number | null> = {
    groundedness: mean(results.map((r) => r.scores.groundedness)),
    answerRelevance: mean(results.map((r) => r.scores.answerRelevance)),
    correctness: mean(results.map((r) => r.scores.correctness)),
    tone: mean(results.map((r) => r.scores.tone)),
    citationValidity: mean(results.map((r) => r.scores.citationValidity)),
    contextRecall: mean(results.map((r) => r.scores.contextRecall)),
    contextPrecision: mean(results.map((r) => r.scores.contextPrecision)),
    refusalCorrectness: mean(results.map((r) => r.scores.refusalCorrectness)),
    meanLatencyMs: mean(results.map((r) => r.latencyMs)),
  };

  const overall = mean(results.map((r) => r.overall)) ?? 0;
  const passedCases = results.filter((r) => r.passed).length;
  const threshold = options.passThreshold ?? appConfig.evaluator.passThreshold;
  const durationMs = Date.now() - startedAt;

  if (runId) {
    await persistResults(runId, results, { ...metrics, overall }, passedCases, threshold);
  }

  return {
    runId,
    name,
    dataset: datasetPath,
    promptName,
    promptVersion: prompt.version,
    promptHash: prompt.hash,
    config: runConfig,
    results,
    metrics: { ...metrics, overall },
    totalCases: results.length,
    passedCases,
    overall,
    passed: overall >= threshold,
    durationMs,
  };
}

async function persistResults(
  runId: string,
  results: EvalCaseResult[],
  metrics: Record<string, number | null>,
  passedCases: number,
  threshold: number,
) {
  const db = supabaseAdmin();

  try {
    // Chunked to stay under statement size limits on large golden sets.
    for (let i = 0; i < results.length; i += 50) {
      const batch = results.slice(i, i + 50);
      const { error } = await db.from("eval_results").insert(
        batch.map((r) => ({
          run_id: runId,
          case_id: r.caseId,
          repeat_index: r.repeatIndex,
          question: r.question,
          expected: r.expected ?? null,
          answer: r.answer,
          retrieval: r.retrieval.map((c) => ({
            citationId: c.citationId,
            path: c.path,
            title: c.title,
            score: c.score,
            isNeighbor: c.isNeighbor ?? false,
          })),
          scores: r.scores,
          judge: r.judge,
          overall: r.overall,
          passed: r.passed,
          latency_ms: r.latencyMs,
          input_tokens: r.inputTokens ?? null,
          output_tokens: r.outputTokens ?? null,
          error: r.error ?? null,
        })),
      );
      if (error) throw new Error(error.message);
    }

    await db
      .from("eval_runs")
      .update({
        status: "completed",
        summary: { ...metrics, passThreshold: threshold },
        passed_cases: passedCases,
        total_cases: results.length,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);
  } catch (e) {
    log.warn("Could not persist evaluation results", { error: errorMessage(e) });
    await db
      .from("eval_runs")
      .update({ status: "failed", error: errorMessage(e), finished_at: new Date().toISOString() })
      .eq("id", runId);
  }
}
