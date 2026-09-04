import { generateText } from "ai";

import { getRuntimeConfig } from "@/lib/config";
import { getLanguageModel } from "@/lib/ai/registry";
import { renderPrompt } from "@/lib/prompts";
import { retrieve } from "@/lib/rag/retrieve";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createLogger, errorMessage } from "@/lib/logger";
import type { AnswerDraft, RetrievalResult } from "@/lib/types";

const log = createLogger("agent:answer");

export interface AnswerRequest {
  vaultId: string;
  question: string;
  senderName?: string;
  senderEmail?: string;
  subject?: string;
  vaultName?: string;
  /** Skip retrieval by supplying it (used by the evaluator to reuse one pass). */
  retrieval?: RetrievalResult;
  source?: "email" | "playground" | "eval" | "api";
  workspaceId?: string;
  /** Prompt file to use. Lets the evaluator score variants side by side. */
  promptName?: string;
}

export interface AnswerResult extends AnswerDraft {
  retrievalResult: RetrievalResult;
  /** True when nothing relevant was retrieved and no answer was attempted. */
  noContext: boolean;
  promptHash: string;
  promptVersion: string;
}

/** "vivek.anand" -> "Vivek", so the email opens like a person wrote it. */
export function humaniseSenderName(name: string | undefined, email: string | undefined): string {
  if (name && name.trim() && !name.includes("@")) return name.trim();

  const local = (email ?? "").split("@")[0];
  if (!local) return "there";

  const first = local.split(/[._\-+]/)[0];
  if (!first || /^\d+$/.test(first)) return "there";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/**
 * Retrieves context and drafts an answer.
 *
 * Returns `noContext: true` rather than calling the model when retrieval comes
 * back empty. Asking a model to answer from nothing is the single most reliable
 * way to manufacture a hallucination, and the not-found reply is a better
 * outcome than a confident invention.
 */
export async function answerQuestion(request: AnswerRequest): Promise<AnswerResult> {
  const config = await getRuntimeConfig();
  const startedAt = Date.now();

  const retrievalResult =
    request.retrieval ??
    (await retrieve({ vaultId: request.vaultId, query: request.question }));

  const promptName = request.promptName ?? "senderAgent";

  if (retrievalResult.chunks.length === 0) {
    log.info("No context retrieved", { question: request.question.slice(0, 80) });
    return {
      subject: buildReplySubject(request.subject),
      bodyMarkdown: "",
      retrieval: [],
      retrievalResult,
      noContext: true,
      promptHash: "",
      promptVersion: "",
      generation: {
        provider: config.llm.provider,
        model: config.llm.model,
        latencyMs: Date.now() - startedAt,
      },
    };
  }

  const senderName = humaniseSenderName(request.senderName, request.senderEmail);

  const { text: promptText, prompt } = await renderPrompt(promptName, {
    senderName,
    senderEmail: request.senderEmail ?? "unknown",
    subject: request.subject ?? "(no subject)",
    question: request.question,
    context: retrievalResult.contextBlock,
    vaultName: request.vaultName ?? "the knowledge base",
    today: new Date().toISOString().slice(0, 10),
  });

  const { model, provider, modelId } = await getLanguageModel();

  const { text, usage } = await generateText({
    model,
    prompt: promptText,
    temperature: config.llm.temperature,
    maxOutputTokens: config.llm.maxOutputTokens,
  });

  const latencyMs = Date.now() - startedAt;
  const bodyMarkdown = text.trim();

  const result: AnswerResult = {
    subject: buildReplySubject(request.subject),
    bodyMarkdown,
    retrieval: retrievalResult.chunks,
    retrievalResult,
    noContext: false,
    promptHash: prompt.hash,
    promptVersion: prompt.version,
    generation: {
      provider,
      model: modelId,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      latencyMs,
    },
  };

  // Logging is best-effort: a failed insert must not lose the answer itself.
  void logQuery(request, result).catch((e) =>
    log.warn("Could not write query log", { error: errorMessage(e) }),
  );

  return result;
}

/** Keeps a single `Re: ` prefix, however the original subject was written. */
export function buildReplySubject(subject: string | undefined): string {
  const base = (subject ?? "").trim();
  if (!base) return "Re: your question";
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

async function logQuery(request: AnswerRequest, result: AnswerResult) {
  const db = supabaseAdmin();
  await db.from("query_logs").insert({
    workspace_id: request.workspaceId ?? null,
    vault_id: request.vaultId,
    source: request.source ?? "email",
    question: request.question,
    answer: result.bodyMarkdown,
    retrieval: result.retrieval.map((c) => ({
      citationId: c.citationId,
      chunkId: c.chunkId,
      path: c.path,
      title: c.title,
      score: c.score,
      similarity: c.similarity,
      isNeighbor: c.isNeighbor ?? false,
    })),
    provider: result.generation.provider,
    model: result.generation.model,
    input_tokens: result.generation.inputTokens ?? null,
    output_tokens: result.generation.outputTokens ?? null,
    latency_ms: result.generation.latencyMs,
  });
}

/**
 * The reply used when the vault has no answer, or the grounding gate blocked
 * the drafted one.
 */
export async function composeNotFoundReply(params: {
  senderName?: string;
  senderEmail?: string;
  question: string;
  topic?: string;
  vaultName?: string;
}): Promise<string> {
  const senderName = humaniseSenderName(params.senderName, params.senderEmail);

  try {
    const { text: promptText } = await renderPrompt("notFoundReply", {
      senderName,
      question: params.question,
      topic: params.topic ?? params.question.slice(0, 60),
      vaultName: params.vaultName ?? "the knowledge base",
    });

    const { model } = await getLanguageModel();
    const { text } = await generateText({
      model,
      prompt: promptText,
      temperature: 0.3,
      maxOutputTokens: 300,
    });

    return text.trim();
  } catch (e) {
    // This reply must always be sendable, so fall back to a fixed message
    // rather than leaving the sender with silence.
    log.warn("Could not generate not-found reply, using the static fallback", {
      error: errorMessage(e),
    });
    return (
      `Hi ${senderName},\n\n` +
      `I looked through the notes and could not find anything covering this. ` +
        `If you rephrase the question or narrow it down, it is worth another try.\n`
    );
  }
}
