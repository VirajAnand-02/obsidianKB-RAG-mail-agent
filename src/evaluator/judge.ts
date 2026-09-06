import { generateObject } from "ai";
import { z } from "zod";

import { looseString } from "@/lib/ai/schema";

import { getJudgeModel } from "@/lib/ai/registry";
import { renderPrompt } from "@/lib/prompts";
import { createLogger, errorMessage } from "@/lib/logger";
import type { RetrievedChunk } from "@/lib/types";

const log = createLogger("eval:judge");

/**
 * LLM-as-judge scoring.
 *
 * Each judge scores one narrow axis with its own prompt. Splitting them matters:
 * a single "rate this answer 1-10" prompt produces a number nobody can act on,
 * whereas "groundedness 0.4, tone 0.9" says exactly what to go and fix.
 *
 * Judges are called at temperature 0 with a structured schema, and every one
 * degrades to a null score rather than throwing — a judge outage should leave a
 * gap in the report, not fail the run.
 */

const groundednessSchema = z.object({
  score: z.number().min(0).max(1).nullable(),
  applicable: z.boolean().default(true),
  totalClaims: z.number().default(0),
  supportedClaims: z.number().default(0),
  claims: z
    .array(
      z.object({
        claim: z.string(),
        label: z.enum(["supported", "partial", "unsupported", "contradicted"]),
        evidence: z.string().nullable().default(null),
      }),
    )
    .default([]),
  reasoning: looseString(""),
});

const qualitySchema = z.object({
  answerRelevance: z.number().min(0).max(1),
  correctness: z.number().min(0).max(1).nullable(),
  hasReference: z.boolean().default(false),
  missingPoints: z.array(z.string()).default([]),
  incorrectPoints: z.array(z.string()).default([]),
  reasoning: looseString(""),
});

const toneSchema = z.object({
  tone: z.number().min(0).max(1),
  formatIssues: z.array(z.string()).default([]),
  sendable: z.boolean().default(true),
  worstProblem: z.string().nullable().default(null),
  reasoning: looseString(""),
});

const relevanceSchema = z.object({
  ratings: z
    .array(z.object({ id: z.string(), rating: z.number().min(0).max(2), why: looseString("") }))
    .default([]),
  bestId: z.string().nullable().default(null),
  missingInformation: z.string().nullable().default(null),
});

/** Runs one judge, returning null on failure instead of throwing. */
async function runJudge<T>(
  name: string,
  promptName: string,
  variables: Record<string, string>,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const { text } = await renderPrompt(promptName, variables, "evaluator");
    const { model } = await getJudgeModel();

    const { object } = await generateObject({
      model,
      schema,
      prompt: text,
      temperature: 0,
      maxOutputTokens: 2500,
    });

    return object;
  } catch (e) {
    log.warn(`Judge "${name}" failed`, { error: errorMessage(e) });
    return null;
  }
}

export function judgeGroundedness(params: {
  question: string;
  answer: string;
  context: string;
}) {
  return runJudge("groundedness", "groundednessJudge", params, groundednessSchema);
}

export function judgeAnswerQuality(params: {
  question: string;
  answer: string;
  expected?: string;
}) {
  return runJudge(
    "answerQuality",
    "answerQuality",
    { ...params, expected: params.expected?.trim() || "none" },
    qualitySchema,
  );
}

export function judgeTone(params: { question: string; answer: string }) {
  return runJudge("emailTone", "emailToneJudge", params, toneSchema);
}

export async function judgeRetrievalRelevance(params: {
  question: string;
  chunks: RetrievedChunk[];
}) {
  if (params.chunks.length === 0) return null;

  const rendered = params.chunks
    .map(
      (c) =>
        `[${c.citationId ?? c.chunkId.slice(0, 6)}] ${c.title}${c.isNeighbor ? " (neighbour)" : ""}\n` +
        `${c.content.slice(0, 1200)}`,
    )
    .join("\n\n---\n\n");

  return runJudge(
    "retrievalRelevance",
    "retrievalRelevance",
    { question: params.question, chunks: rendered },
    relevanceSchema,
  );
}

export type GroundednessJudgement = z.infer<typeof groundednessSchema>;
export type QualityJudgement = z.infer<typeof qualitySchema>;
export type ToneJudgement = z.infer<typeof toneSchema>;
export type RelevanceJudgement = z.infer<typeof relevanceSchema>;
