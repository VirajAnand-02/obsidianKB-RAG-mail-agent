import { NextResponse } from "next/server";
import { generateText } from "ai";

import { requireAdminApi } from "@/lib/auth";
import { getRuntimeConfig } from "@/lib/config";
import { getLanguageModel } from "@/lib/ai/registry";
import { createLogger, errorMessage } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger("api:test-llm");

/** Long enough for a cold provider, short enough that the button is not a hang. */
const TIMEOUT_MS = 20_000;

/**
 * Sends one throwaway generation to the configured language model.
 *
 * The settings page can tell you a key is *stored*; it cannot tell you the key
 * is valid, the model id exists at that provider, or the endpoint is reachable.
 * Those only fail at the first real email, where the failure surfaces as a
 * trace routed to human review rather than as "your API key is wrong".
 *
 * Takes the provider and model from the request so the button checks what is on
 * screen, including a selection that has not been saved yet. Credentials are not
 * accepted here — a key typed into the form has to be saved before it can be
 * tested, since that is where encryption happens.
 */
export async function POST(request: Request) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const config = await getRuntimeConfig();

  // Plain strings: an unrecognised provider is a normal check failure to be
  // reported, not a type error to be prevented.
  let provider: string = config.llm.provider;
  let model: string = config.llm.model;

  try {
    const body = (await request.json()) as { provider?: unknown; model?: unknown };
    if (typeof body.provider === "string" && body.provider.trim()) provider = body.provider.trim();
    if (typeof body.model === "string" && body.model.trim()) model = body.model.trim();
  } catch {
    // No body: fall back to the saved configuration.
  }

  const startedAt = Date.now();

  try {
    const { model: languageModel, provider: resolvedProvider, modelId } = await getLanguageModel(
      provider,
      model,
    );

    const { text } = await generateText({
      model: languageModel,
      prompt: 'Reply with the single word "ok".',
      temperature: 0,
      maxOutputTokens: 32,
      // One attempt. The SDK's default of three turns a rate limit into a
      // seven-second wait and then reports it anyway; for a check, the first
      // answer is the honest one and arrives while the button still has your
      // attention.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    });

    return NextResponse.json({
      ok: true,
      provider: resolvedProvider,
      model: modelId,
      latencyMs: Date.now() - startedAt,
      // Some models spend the budget on reasoning and return nothing. The call
      // completing is the signal; the reply is shown only as corroboration.
      reply: text.trim().slice(0, 80),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    const message = timedOut
      ? `No response from ${provider} within ${TIMEOUT_MS / 1000}s.`
      : errorMessage(e);

    log.warn("Language model check failed", { provider, model, error: message });

    // 200 with `ok: false`: the request was handled correctly and the answer is
    // "the model is not working". A 5xx here would read as the dashboard being
    // broken, which is the opposite of what the check just established.
    return NextResponse.json({
      ok: false,
      provider,
      model,
      latencyMs: Date.now() - startedAt,
      error: message,
    });
  }
}
