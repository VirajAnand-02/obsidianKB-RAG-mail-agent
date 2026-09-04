import { generateObject } from "ai";
import { z } from "zod";

import { getRuntimeConfig } from "@/lib/config";
import { getGroundingModel } from "@/lib/ai/registry";
import { renderPrompt } from "@/lib/prompts";
import { createLogger, errorMessage } from "@/lib/logger";
import type { GateDecision, GroundingReport, RetrievedChunk } from "@/lib/types";

const log = createLogger("agent:grounding");

/**
 * The grounding gate.
 *
 * Nothing this system generates reaches a human inbox without passing through
 * here. A second model reads the draft against the retrieved excerpts, scores
 * how much of it is actually supported, and the score maps to one of three
 * outcomes: send, queue for human review, or block.
 *
 * The gate fails closed. If the judge errors, times out, or returns something
 * unparseable, the draft goes to review rather than out the door — the whole
 * point is that an unverified answer is not sent unattended.
 */

const claimSchema = z.object({
  claim: z.string(),
  status: z.enum(["supported", "partial", "unsupported", "contradicted"]),
  citedIds: z.array(z.string()).default([]),
  supportingIds: z.array(z.string()).default([]),
  note: z.string().optional(),
});

const reportSchema = z.object({
  score: z.number().min(0).max(1),
  verdict: z.enum(["pass", "review", "block"]),
  claims: z.array(claimSchema).default([]),
  unsupportedClaims: z.array(z.string()).default([]),
  hallucinationRisk: z.enum(["low", "medium", "high"]).default("medium"),
  missingCitations: z.boolean().default(false),
  reasoning: z.string().default(""),
});

/** Citation ids the draft references, e.g. [C3]. */
export function extractCitedIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\[(C\d+)\]/g)].map((m) => m[1]))];
}

/**
 * Deterministic pre-checks run before the model is asked anything.
 *
 * These catch the failure modes that do not need judgement — a citation
 * pointing at an excerpt that was never retrieved is provably wrong, and it is
 * both cheaper and more reliable to catch it here than to hope a judge notices.
 */
export function checkCitations(
  draft: string,
  chunks: RetrievedChunk[],
): { valid: boolean; invalidIds: string[]; hasCitations: boolean } {
  const available = new Set(chunks.map((c) => c.citationId).filter(Boolean) as string[]);
  const cited = extractCitedIds(draft);
  const invalidIds = cited.filter((id) => !available.has(id));

  return { valid: invalidIds.length === 0, invalidIds, hasCitations: cited.length > 0 };
}

export interface GroundingInput {
  question: string;
  draft: string;
  chunks: RetrievedChunk[];
  contextBlock: string;
}

export async function checkGrounding(input: GroundingInput): Promise<GroundingReport> {
  const config = await getRuntimeConfig();

  if (!config.grounding.enabled) {
    return {
      score: 1,
      verdict: "skipped",
      claims: [],
      unsupportedClaims: [],
      hallucinationRisk: "low",
      missingCitations: false,
      reasoning: "Grounding checks are disabled in Settings.",
    };
  }

  const citations = checkCitations(input.draft, input.chunks);

  // A fabricated citation id is disqualifying on its own; no need to spend a
  // model call confirming it.
  if (!citations.valid) {
    return {
      score: 0.2,
      verdict: "block",
      claims: [],
      unsupportedClaims: [],
      hallucinationRisk: "high",
      missingCitations: true,
      reasoning:
        `The draft cites ${citations.invalidIds.join(", ")}, which ${
          citations.invalidIds.length === 1 ? "was" : "were"
        } not among the retrieved excerpts. Fabricated citations are treated as hallucination.`,
    };
  }

  try {
    const { text: promptText } = await renderPrompt("groundingCheck", {
      question: input.question,
      draft: input.draft,
      context: input.contextBlock,
    });

    const { model } = await getGroundingModel();

    const { object } = await generateObject({
      model,
      schema: reportSchema,
      prompt: promptText,
      // Verification should be as close to deterministic as the provider allows.
      temperature: 0,
      maxOutputTokens: 2000,
    });

    const report: GroundingReport = { ...object, verdict: object.verdict };

    // Citations are required but absent: cap the score regardless of the judge's
    // opinion, since an uncited answer cannot be audited by the reviewer either.
    if (config.grounding.requireCitations && !citations.hasCitations) {
      report.score = Math.min(report.score, 0.5);
      report.missingCitations = true;
      report.reasoning +=
        " No citations were present in the draft, which is required by the current settings.";
    }

    return report;
  } catch (e) {
    const message = errorMessage(e);
    log.error("Grounding check failed", { error: message });

    return {
      score: 0,
      verdict: "error",
      claims: [],
      unsupportedClaims: [],
      hallucinationRisk: "high",
      missingCitations: false,
      reasoning: `The grounding check could not be completed: ${message}`,
      failedOpen: false,
    };
  }
}

/**
 * Applies the configured thresholds to a report.
 *
 * The judge proposes a verdict; the thresholds decide. Keeping the numeric
 * decision here rather than in the prompt means changing the risk appetite is a
 * settings change, and the same draft always produces the same routing.
 */
export async function applyGate(report: GroundingReport): Promise<GateDecision> {
  const config = await getRuntimeConfig();
  const { autosendThreshold, reviewThreshold, failMode } = config.grounding;

  if (report.verdict === "skipped") {
    return {
      action: "send",
      report,
      rationale: "Grounding checks are disabled; sending without verification.",
    };
  }

  if (report.verdict === "error") {
    const action = failMode === "send" ? "send" : failMode === "block" ? "block" : "review";
    return {
      action,
      report: { ...report, failedOpen: action === "send" },
      rationale: `The grounding check errored. GROUNDING_FAIL_MODE is "${failMode}", so this was routed to ${action}.`,
    };
  }

  // An explicit block from the judge overrides the score: it means the draft
  // contradicts the notes, which no threshold should be able to wave through.
  if (report.verdict === "block") {
    return {
      action: "block",
      report,
      rationale: `Blocked by the grounding judge: ${report.reasoning}`,
    };
  }

  if (report.score >= autosendThreshold && report.verdict === "pass") {
    return {
      action: "send",
      report,
      rationale: `Score ${report.score.toFixed(2)} met the auto-send threshold of ${autosendThreshold}.`,
    };
  }

  if (report.score >= reviewThreshold) {
    return {
      action: "review",
      report,
      rationale:
        `Score ${report.score.toFixed(2)} is between the review threshold (${reviewThreshold}) ` +
        `and auto-send (${autosendThreshold}), so a human should confirm it.`,
    };
  }

  return {
    action: "block",
    report,
    rationale: `Score ${report.score.toFixed(2)} is below the review threshold of ${reviewThreshold}.`,
  };
}

/** Convenience wrapper: check, then route. */
export async function gateDraft(input: GroundingInput): Promise<GateDecision> {
  const report = await checkGrounding(input);
  return applyGate(report);
}
