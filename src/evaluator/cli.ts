import "dotenv/config";
import { readFile } from "node:fs/promises";

import { runEvaluation, type RunSummary } from "@/evaluator/runner";
import { printComparison, printReport, writeReport } from "@/evaluator/report";
import { errorMessage } from "@/lib/logger";

/**
 * Evaluation CLI.
 *
 *   npm run eval                                    run the golden set
 *   npm run eval -- --fast                          deterministic metrics only
 *   npm run eval -- --prompt senderAgentV2          score a prompt variant
 *   npm run eval -- --compare eval-results/x.json   diff against a saved run
 *   npm run eval -- --tags refusal,code --repeats 3
 *
 * Exits non-zero when the overall score is below EVAL_PASS_THRESHOLD, so it can
 * gate a CI job the same way a test suite does.
 */

interface Args {
  dataset?: string;
  prompt?: string;
  name?: string;
  vault?: string;
  concurrency?: number;
  repeats?: number;
  threshold?: number;
  tags?: string[];
  fast: boolean;
  noPersist: boolean;
  noWrite: boolean;
  compare?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { fast: false, noPersist: false, noWrite: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];

    switch (arg) {
      case "--dataset":
      case "-d":
        args.dataset = next();
        break;
      case "--prompt":
      case "-p":
        args.prompt = next();
        break;
      case "--name":
      case "-n":
        args.name = next();
        break;
      case "--vault":
        args.vault = next();
        break;
      case "--concurrency":
      case "-c":
        args.concurrency = Number(next());
        break;
      case "--repeats":
      case "-r":
        args.repeats = Number(next());
        break;
      case "--threshold":
      case "-t":
        args.threshold = Number(next());
        break;
      case "--tags":
        args.tags = next()
          ?.split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        break;
      case "--compare":
        args.compare = next();
        break;
      case "--fast":
        args.fast = true;
        break;
      case "--no-persist":
        args.noPersist = true;
        break;
      case "--no-write":
        args.noWrite = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}. Run with --help for usage.`);
          process.exit(2);
        }
    }
  }

  return args;
}

function usage() {
  console.log(`
Obsi-Relay evaluation harness

Usage: npm run eval -- [options]

Options:
  -d, --dataset <path>     Dataset file (default: EVAL_DATASET)
  -p, --prompt <name>      Prompt under test from src/prompts (default: senderAgent)
  -n, --name <name>        Label for this run
      --vault <id>         Vault to evaluate against (default: the default vault)
  -c, --concurrency <n>    Parallel cases (default: EVAL_CONCURRENCY)
  -r, --repeats <n>        Runs per case, to measure variance (default: EVAL_REPEATS)
  -t, --threshold <n>      Pass threshold (default: EVAL_PASS_THRESHOLD)
      --tags <a,b>         Only run cases carrying these tags
      --fast               Skip LLM judges; deterministic metrics only
      --compare <file>     Diff this run against a saved JSON report
      --no-persist         Do not write the run to the database
      --no-write           Do not write report files
  -h, --help               Show this message

Examples:
  npm run eval
  npm run eval -- --fast --tags refusal
  npm run eval -- --prompt senderAgentTerse --name "terse variant"
  npm run eval -- --compare eval-results/senderAgent-2026-09-04.json
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  let progressShown = 0;

  const summary = await runEvaluation({
    dataset: args.dataset,
    promptName: args.prompt,
    name: args.name,
    vaultId: args.vault,
    concurrency: args.concurrency,
    repeats: args.repeats,
    passThreshold: args.threshold,
    tags: args.tags,
    fastMode: args.fast,
    noPersist: args.noPersist,
    onCaseComplete: (result, index, total) => {
      // Single updating line rather than a wall of output.
      const bar = "█".repeat(Math.round((index / total) * 24)).padEnd(24, "░");
      const mark = result.passed ? "✓" : "✗";
      process.stdout.write(
        `\r  ${bar} ${index}/${total}  ${mark} ${result.caseId.slice(0, 28).padEnd(28)}`,
      );
      progressShown = 1;
    },
  });

  if (progressShown) process.stdout.write("\r" + " ".repeat(78) + "\r");

  printReport(summary);

  if (!args.noWrite) {
    const { jsonPath, markdownPath } = await writeReport(summary);
    console.log(`  Report written to:\n    ${jsonPath}\n    ${markdownPath}\n`);
  }

  if (args.compare) {
    try {
      const baseline = JSON.parse(await readFile(args.compare, "utf8")) as RunSummary;
      printComparison(baseline, summary);
    } catch (e) {
      console.error(`  Could not read the baseline report: ${errorMessage(e)}\n`);
    }
  }

  // Non-zero exit lets this gate CI.
  process.exit(summary.passed ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nEvaluation failed: ${errorMessage(e)}\n`);
  process.exit(1);
});
