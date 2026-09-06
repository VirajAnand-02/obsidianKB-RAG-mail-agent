import { generateObject } from "ai";
import { z } from "zod";

import { looseString, optionalString } from "@/lib/ai/schema";
import { getRuntimeConfig } from "@/lib/config";
import { getGroundingModel } from "@/lib/ai/registry";
import { renderPrompt } from "@/lib/prompts";
import { createLogger, errorMessage } from "@/lib/logger";
import type { GateDecision, GroundingClaim, GroundingReport, RetrievedChunk } from "@/lib/types";

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
  // The prompt asks for an explicit `null` when a claim is supported, which is
  // clearer than omitting the key — so the schema has to accept it. A plain
  // `.optional()` here rejected every well-formed report the judge produced.
  note: optionalString(),
});

const reportSchema = z.object({
  score: z.number().min(0).max(1),
  verdict: z.enum(["pass", "review", "block"]),
  claims: z.array(claimSchema).default([]),
  unsupportedClaims: z.array(z.string()).default([]),
  hallucinationRisk: z.enum(["low", "medium", "high"]).default("medium"),
  missingCitations: z.boolean().default(false),
  reasoning: looseString(""),
});

/**
 * Matches a citation bracket, including the grouped form models naturally
 * produce when one sentence draws on several excerpts: `[C1]`, `[C1, C2]`,
 * `[C1,C2]`.
 *
 * Matching only `[C1]` was a real failure: a grouped citation was read as *no*
 * citation, which tripped the "requires citations" cap and sent every
 * multi-source answer to human review.
 */
export const CITATION_PATTERN = /\[\s*(C\d+(?:\s*,\s*C\d+)*)\s*\]/g;

/** Citation ids the draft references, e.g. [C3] or [C1, C2]. */
export function extractCitedIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(CITATION_PATTERN)) {
    for (const id of match[1].split(",")) ids.add(id.trim());
  }
  return [...ids];
}

/** True when the text carries at least one citation, in any accepted form. */
export function containsCitation(text: string): boolean {
  return new RegExp(CITATION_PATTERN.source).test(text);
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

/** Score caps, mirroring the rubric in groundingCheck.md. */
const PARTIAL_CAP = 0.85;
const UNSUPPORTED_CAP = 0.5;
const CONTRADICTED_CAP = 0.2;

/**
 * Derives the score and verdict from the per-claim statuses.
 *
 * The judge is asked to compute these itself, but asking is not the same as
 * enforcing: a real report came back with all five claims marked `supported`
 * and a score of 0.8 with verdict `review`, downgraded in prose over a phrase
 * the model disliked but never recorded as a claim. That is unauditable — the
 * reviewer sees a penalty with nothing behind it.
 *
 * Computing both here makes the claim list the single source of truth. The
 * judge can still influence the outcome, but only by saying which claim is
 * weak, which is exactly the thing a human can check.
 */
export function scoreFromClaims(claims: GroundingClaim[]): {
  score: number;
  verdict: "pass" | "review" | "block";
} {
  if (claims.length === 0) return { score: 1, verdict: "pass" };

  const supported = claims.filter((c) => c.status === "supported").length;
  const partial = claims.filter((c) => c.status === "partial").length;
  const unsupported = claims.filter((c) => c.status === "unsupported").length;
  const contradicted = claims.filter((c) => c.status === "contradicted").length;

  // Partial claims earn half credit: the substance is there, a detail is not.
  let score = (supported + 0.5 * partial) / claims.length;
  if (partial > 0) score = Math.min(score, PARTIAL_CAP);
  if (unsupported > 0) score = Math.min(score, UNSUPPORTED_CAP);
  if (contradicted > 0) score = Math.min(score, CONTRADICTED_CAP);

  // Only a claim the notes cannot support is a hard stop. Everything else is
  // left to the score, so `autosendThreshold` is a dial that actually moves —
  // previously any partial forced review regardless of what it was set to.
  const verdict = contradicted > 0 || unsupported > 0 ? "block" : "pass";

  return { score: Number(score.toFixed(3)), verdict };
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

    const computed = scoreFromClaims(object.claims);

    // A judge whose own numbers disagree with its claim list is drifting from
    // the rubric. Worth seeing in the log, but the computed value is what counts.
    if (Math.abs(computed.score - object.score) > 0.05 || computed.verdict !== object.verdict) {
      log.warn("Grounding judge disagreed with its own claims; using the computed result", {
        reported: { score: object.score, verdict: object.verdict },
        computed,
        claims: object.claims.map((c) => c.status),
      });
    }

    const report: GroundingReport = {
      ...object,
      score: computed.score,
      // A `block` from the judge is a safety escalation ("this would mislead"),
      // so it is honoured even when the claim statuses do not force it. The
      // reverse — a silent downgrade to `review` — is not.
      verdict: object.verdict === "block" ? "block" : computed.verdict,
    };

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
