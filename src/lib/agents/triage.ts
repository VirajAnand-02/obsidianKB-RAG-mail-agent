import { generateObject } from "ai";
import { z } from "zod";

import { looseString, nullableString } from "@/lib/ai/schema";

import { getLanguageModel } from "@/lib/ai/registry";
import { renderPrompt } from "@/lib/prompts";
import { createLogger, errorMessage } from "@/lib/logger";

const log = createLogger("agent:triage");

const triageSchema = z.object({
  classification: z.enum(["question", "ignore", "human"]),
  // The prompt asks for null on every one of these when there is nothing to
  // report, and `reason` is explicitly null on the happy path — a plain
  // `z.string()` rejected it, so every genuine question failed to parse,
  // fell back to "human", and was forced into review.
  question: nullableString(),
  topic: looseString(""),
  confidence: z.number().min(0).max(1).default(0.5),
  reason: looseString(""),
});

export type TriageResult = z.infer<typeof triageSchema>;

/**
 * Decides whether an inbound email should be answered automatically.
 *
 * Runs before retrieval, so a bounce, a newsletter, or a prompt-injection
 * attempt never reaches the answering path at all. On failure it returns
 * `human` rather than `question`: an unclassifiable email is exactly the kind
 * that should not get an automatic reply.
 */
export async function triageEmail(params: {
  fromEmail: string;
  subject: string;
  body: string;
}): Promise<TriageResult> {
  try {
    const { text: promptText } = await renderPrompt("emailTriage", {
      fromEmail: params.fromEmail,
      subject: params.subject || "(no subject)",
      body: params.body,
    });

    const { model } = await getLanguageModel();

    const { object } = await generateObject({
      model,
      schema: triageSchema,
      prompt: promptText,
      temperature: 0,
      maxOutputTokens: 600,
    });

    // A `question` verdict with no extractable question is not actionable.
    if (object.classification === "question" && !object.question?.trim()) {
      return {
        ...object,
        classification: "human",
        reason: "Classified as a question but no question could be extracted.",
      };
    }

    return object;
  } catch (e) {
    log.error("Triage failed, routing to human review", { error: errorMessage(e) });
    return {
      classification: "human",
      question: params.body.slice(0, 2000),
      topic: params.subject,
      confidence: 0,
      reason: `Triage could not be completed: ${errorMessage(e)}`,
    };
  }
}
