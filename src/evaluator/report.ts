import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { appConfig } from "@/lib/app-config";
import type { RunSummary } from "@/evaluator/runner";

/**
 * Evaluation reporting.
 *
 * Three outputs, because they answer different questions:
 *  - console: did this run pass, and which cases dragged it down
 *  - markdown: a diffable artefact to attach to a PR
 *  - json: the raw results, for comparing runs later
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

function colourFor(score: number | null): string {
  if (score === null) return DIM;
  if (score >= 0.8) return GREEN;
  if (score >= 0.6) return YELLOW;
  return RED;
}

function fmt(score: number | null | undefined, width = 5): string {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return DIM + "  -  ".slice(0, width) + RESET;
  }
  return `${colourFor(score)}${score.toFixed(2).padStart(width)}${RESET}`;
}

const METRIC_LABELS: Record<string, string> = {
  groundedness: "Groundedness",
  citationValidity: "Citation validity",
  answerRelevance: "Answer relevance",
  correctness: "Correctness",
  contextRecall: "Context recall",
  contextPrecision: "Context precision",
  refusalCorrectness: "Refusal correctness",
  tone: "Tone",
};

export function printReport(summary: RunSummary): void {
  const { metrics, results } = summary;

  console.log(`\n${BOLD}Evaluation: ${summary.name}${RESET}`);
  console.log(`${DIM}${"─".repeat(64)}${RESET}`);
  console.log(`  dataset   ${summary.dataset}`);
  console.log(`  prompt    ${summary.promptName} v${summary.promptVersion} (${summary.promptHash})`);

  const config = summary.config as Record<string, Record<string, unknown>>;
  console.log(`  model     ${config.llm?.provider}/${config.llm?.model}`);
  console.log(
    `  embedding ${config.embedding?.provider}/${config.embedding?.model} (${config.embedding?.dimensions}d)`,
  );
  console.log(
    `  retrieval topK=${config.retrieval?.topK} hybrid=${config.retrieval?.hybrid} ` +
      `expansion=${config.retrieval?.queryExpansion} rerank=${config.retrieval?.reranker}`,
  );

  console.log(`\n${BOLD}  Metrics${RESET}`);
  for (const [key, label] of Object.entries(METRIC_LABELS)) {
    const value = metrics[key];
    if (value === undefined) continue;
    console.log(`    ${label.padEnd(22)} ${fmt(value)}`);
  }

  console.log(`\n${BOLD}  Overall${RESET}          ${fmt(summary.overall)}`);
  console.log(
    `  ${summary.passedCases}/${summary.totalCases} cases passed` +
      `${DIM}  ·  ${(summary.durationMs / 1000).toFixed(1)}s` +
      `  ·  mean ${Math.round(metrics.meanLatencyMs ?? 0)}ms/case${RESET}`,
  );

  // Worst cases are the actionable part of the report, so they are always shown.
  const worst = [...results]
    .filter((r) => !r.passed)
    .sort((a, b) => a.overall - b.overall)
    .slice(0, 8);

  if (worst.length > 0) {
    console.log(`\n${BOLD}  Weakest cases${RESET}`);
    for (const result of worst) {
      console.log(`\n    ${fmt(result.overall)}  ${BOLD}${result.caseId}${RESET}`);
      console.log(`           ${DIM}${result.question.slice(0, 76)}${RESET}`);

      if (result.error) {
        console.log(`           ${RED}error: ${result.error}${RESET}`);
        continue;
      }

      const weak = Object.entries(result.scores)
        .filter(([, v]) => typeof v === "number" && v < 0.7)
        .map(([k, v]) => `${k}=${(v as number).toFixed(2)}`);
      if (weak.length) console.log(`           ${YELLOW}${weak.join("  ")}${RESET}`);

      const judge = result.judge as {
        relevance?: { missingInformation?: string | null };
        groundedness?: { reasoning?: string };
      };
      if (judge.relevance?.missingInformation) {
        console.log(`           ${DIM}missing: ${judge.relevance.missingInformation.slice(0, 76)}${RESET}`);
      }
    }
  }

  const verdict = summary.passed
    ? `${GREEN}${BOLD}PASS${RESET}`
    : `${RED}${BOLD}FAIL${RESET}`;
  console.log(`\n${DIM}${"─".repeat(64)}${RESET}`);
  console.log(`  ${verdict}  overall ${summary.overall.toFixed(3)} vs threshold ${appConfig.evaluator.passThreshold}\n`);
}

export function toMarkdown(summary: RunSummary): string {
  const config = summary.config as Record<string, Record<string, unknown>>;
  const rows = Object.entries(METRIC_LABELS)
    .filter(([key]) => summary.metrics[key] !== undefined)
    .map(([key, label]) => {
      const value = summary.metrics[key];
      return `| ${label} | ${value === null ? "n/a" : value.toFixed(3)} |`;
    })
    .join("\n");

  const failures = summary.results
    .filter((r) => !r.passed)
    .sort((a, b) => a.overall - b.overall)
    .slice(0, 15)
    .map(
      (r) =>
        `| \`${r.caseId}\` | ${r.overall.toFixed(2)} | ${r.error ? `error: ${r.error}` : r.question.slice(0, 70)} |`,
    )
    .join("\n");

  return `# Evaluation report

**${summary.name}**

- Result: **${summary.passed ? "PASS" : "FAIL"}** (${summary.overall.toFixed(3)} vs ${appConfig.evaluator.passThreshold})
- Cases: ${summary.passedCases}/${summary.totalCases} passed
- Duration: ${(summary.durationMs / 1000).toFixed(1)}s
- Prompt: \`${summary.promptName}\` v${summary.promptVersion} (\`${summary.promptHash}\`)
- Dataset: \`${summary.dataset}\`

## Configuration

| Setting | Value |
| --- | --- |
| LLM | ${config.llm?.provider}/${config.llm?.model} |
| Embedding | ${config.embedding?.provider}/${config.embedding?.model} (${config.embedding?.dimensions}d) |
| Chunking | ${config.chunking?.strategy}, ${config.chunking?.sizeTokens} tokens, ${config.chunking?.overlapTokens} overlap |
| Retrieval | topK=${config.retrieval?.topK}, hybrid=${config.retrieval?.hybrid}, expansion=${config.retrieval?.queryExpansion}, rerank=${config.retrieval?.reranker} |

## Metrics

| Metric | Score |
| --- | --- |
${rows}
| **Overall** | **${summary.overall.toFixed(3)}** |

${failures ? `## Failing cases\n\n| Case | Score | Question |\n| --- | --- | --- |\n${failures}\n` : "All cases passed.\n"}
`;
}

/** Writes the JSON and markdown artefacts, returning their paths. */
export async function writeReport(
  summary: RunSummary,
  outputDir = appConfig.evaluator.outputDir,
): Promise<{ jsonPath: string; markdownPath: string }> {
  const dir = path.isAbsolute(outputDir) ? outputDir : path.join(process.cwd(), outputDir);
  await mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = `${summary.promptName}-${stamp}`;

  const jsonPath = path.join(dir, `${slug}.json`);
  const markdownPath = path.join(dir, `${slug}.md`);

  await writeFile(jsonPath, JSON.stringify(summary, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(summary), "utf8");

  return { jsonPath, markdownPath };
}

/**
 * Compares two runs metric by metric.
 *
 * This is the output that actually drives decisions: a single run tells you
 * where you are, a comparison tells you whether the change you just made helped.
 */
export function printComparison(baseline: RunSummary, candidate: RunSummary): void {
  console.log(`\n${BOLD}Comparison${RESET}`);
  console.log(`  baseline   ${baseline.name}`);
  console.log(`  candidate  ${candidate.name}`);
  console.log(`${DIM}${"─".repeat(64)}${RESET}`);
  console.log(`  ${"Metric".padEnd(22)} ${"base".padStart(6)} ${"cand".padStart(7)} ${"delta".padStart(8)}`);

  const keys = [...Object.keys(METRIC_LABELS), "overall"];
  for (const key of keys) {
    const a = key === "overall" ? baseline.overall : baseline.metrics[key];
    const b = key === "overall" ? candidate.overall : candidate.metrics[key];
    if (typeof a !== "number" || typeof b !== "number") continue;

    const delta = b - a;
    // Anything under a point is noise at typical golden-set sizes.
    const colour = Math.abs(delta) < 0.01 ? DIM : delta > 0 ? GREEN : RED;
    const sign = delta > 0 ? "+" : "";
    const label = key === "overall" ? "Overall" : METRIC_LABELS[key];

    console.log(
      `  ${label.padEnd(22)} ${a.toFixed(3)}  ${b.toFixed(3)}  ` +
        `${colour}${(sign + delta.toFixed(3)).padStart(7)}${RESET}`,
    );
  }
  console.log();
}
