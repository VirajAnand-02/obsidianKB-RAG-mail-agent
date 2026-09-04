// Must precede every provider import: blank env values break their module init.
import "@/lib/env-normalize";

import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createCohere } from "@ai-sdk/cohere";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import { env, type LlmProvider } from "@/lib/env";
import { appConfig } from "@/lib/app-config";
import { getRuntimeConfig } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";
import { isDatabaseConfigured, supabaseAdmin } from "@/lib/supabase/admin";
import { createLogger, errorMessage } from "@/lib/logger";

const log = createLogger("ai:registry");

/**
 * Provider-independent model resolution.
 *
 * Every call site asks for "the current model" rather than a specific vendor, so
 * switching provider in the dashboard changes behaviour everywhere at once —
 * answering, grounding, query expansion, and the evaluator's judge.
 *
 * API keys resolve from `provider_credentials` (encrypted, set in the UI) first,
 * then the environment.
 */

const CREDENTIAL_TTL_MS = 30_000;
let credentialCache: { at: number; keys: Record<string, string> } | null = null;

async function storedCredentials(): Promise<Record<string, string>> {
  if (credentialCache && Date.now() - credentialCache.at < CREDENTIAL_TTL_MS) {
    return credentialCache.keys;
  }
  if (!isDatabaseConfigured()) return {};

  try {
    const { data, error } = await supabaseAdmin()
      .from("provider_credentials")
      .select("provider, ciphertext, iv, auth_tag");
    if (error) throw error;

    const keys: Record<string, string> = {};
    for (const row of data ?? []) {
      try {
        keys[row.provider as string] = decryptSecret({
          ciphertext: row.ciphertext as string,
          iv: row.iv as string,
          authTag: row.auth_tag as string,
        });
      } catch (e) {
        // A single undecryptable row (rotated key) must not break the others.
        log.warn("Could not decrypt stored credential", {
          provider: row.provider,
          error: errorMessage(e),
        });
      }
    }
    credentialCache = { at: Date.now(), keys };
    return keys;
  } catch (e) {
    log.warn("Could not read provider_credentials", { error: errorMessage(e) });
    return {};
  }
}

export function invalidateCredentialCache() {
  credentialCache = null;
}

const ENV_KEY_BY_PROVIDER: Record<string, keyof typeof env> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  xai: "XAI_API_KEY",
  cohere: "COHERE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  azure: "AZURE_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
  jina: "JINA_API_KEY",
  huggingface: "HUGGINGFACE_API_KEY",
  voyage: "VOYAGE_API_KEY",
  resend: "RESEND_API_KEY",
  // Ollama runs locally and needs no key; its endpoint lives in appConfig.
  ollama: "" as keyof typeof env,
};

/** Stored credential first, then environment. Empty string when unset. */
export async function resolveApiKey(provider: string): Promise<string> {
  const stored = await storedCredentials();
  if (stored[provider]) return stored[provider];

  const envKey = ENV_KEY_BY_PROVIDER[provider];
  if (!envKey) return "";
  const value = env[envKey];
  return typeof value === "string" ? value : "";
}

/** Providers that can actually be used right now, for the settings dropdown. */
export async function availableProviders(): Promise<
  { provider: LlmProvider; configured: boolean }[]
> {
  const stored = await storedCredentials();
  return (Object.keys(ENV_KEY_BY_PROVIDER) as string[])
    .filter((p): p is LlmProvider => p !== "resend" && p !== "jina" && p !== "huggingface" && p !== "voyage")
    .map((provider) => {
      if (provider === "ollama") return { provider, configured: Boolean(appConfig.llm.ollamaBaseUrl) };
      const envKey = ENV_KEY_BY_PROVIDER[provider];
      const fromEnv = envKey ? env[envKey] : "";
      return {
        provider,
        configured: Boolean(stored[provider] || (typeof fromEnv === "string" && fromEnv)),
      };
    });
}

function missingKey(provider: string): never {
  throw new Error(
    `No API key configured for provider "${provider}". Add it in Settings -> Providers, ` +
      `or set ${ENV_KEY_BY_PROVIDER[provider] ?? "the provider key"} in .env.`,
  );
}

/**
 * Builds a LanguageModel for the given provider/model.
 * Omitting either falls back to the current runtime configuration.
 */
export async function getLanguageModel(
  provider?: string,
  model?: string,
): Promise<{ model: LanguageModel; provider: string; modelId: string }> {
  const config = await getRuntimeConfig();
  const p = (provider || config.llm.provider) as LlmProvider;
  const m = model || config.llm.model;
  const apiKey = await resolveApiKey(p);

  const languageModel = ((): LanguageModel => {
    switch (p) {
      case "openai":
        if (!apiKey) missingKey(p);
        return createOpenAI({
          apiKey,
          ...(appConfig.llm.openaiBaseUrl ? { baseURL: appConfig.llm.openaiBaseUrl } : {}),
        })(m);

      case "anthropic":
        if (!apiKey) missingKey(p);
        return createAnthropic({ apiKey })(m);

      case "google":
        if (!apiKey) missingKey(p);
        return createGoogleGenerativeAI({ apiKey })(m);

      case "mistral":
        if (!apiKey) missingKey(p);
        return createMistral({ apiKey })(m);

      case "groq":
        if (!apiKey) missingKey(p);
        return createGroq({ apiKey })(m);

      case "deepseek":
        if (!apiKey) missingKey(p);
        return createDeepSeek({ apiKey })(m);

      case "xai":
        if (!apiKey) missingKey(p);
        return createXai({ apiKey })(m);

      case "cohere":
        if (!apiKey) missingKey(p);
        return createCohere({ apiKey })(m);

      case "openrouter":
        if (!apiKey) missingKey(p);
        return createOpenRouter({ apiKey })(m);

      case "azure":
        if (!apiKey) missingKey(p);
        if (!appConfig.llm.azureResourceName) {
          throw new Error("AZURE_RESOURCE_NAME must be set to use the Azure provider.");
        }
        return createAzure({
          apiKey,
          resourceName: appConfig.llm.azureResourceName,
          apiVersion: appConfig.llm.azureApiVersion,
        })(m);

      case "ollama":
        // Local inference: no key, OpenAI-compatible endpoint.
        return createOpenAICompatible({
          name: "ollama",
          baseURL: appConfig.llm.ollamaBaseUrl,
        }).chatModel(m);

      case "openai-compatible":
        if (!appConfig.llm.openaiCompatibleBaseUrl) {
          throw new Error(
            "OPENAI_COMPATIBLE_BASE_URL must be set to use the openai-compatible provider.",
          );
        }
        return createOpenAICompatible({
          name: appConfig.llm.openaiCompatibleName,
          baseURL: appConfig.llm.openaiCompatibleBaseUrl,
          ...(apiKey ? { apiKey } : {}),
        }).chatModel(m);

      default:
        throw new Error(`Unknown LLM provider "${p}".`);
    }
  })();

  return { model: languageModel, provider: p, modelId: m };
}

/**
 * The grounding judge. Defaults to the generation model, but can be pointed at a
 * different (often cheaper or independently-trained) model — using a second
 * model to check the first is worth more than using the same one twice.
 */
export async function getGroundingModel() {
  const config = await getRuntimeConfig();
  return getLanguageModel(
    config.grounding.provider || config.llm.provider,
    config.grounding.model || config.llm.model,
  );
}

/** The evaluator's judge model. */
export async function getJudgeModel() {
  const config = await getRuntimeConfig();
  return getLanguageModel(
    appConfig.evaluator.judgeProvider || config.llm.provider,
    appConfig.evaluator.judgeModel || config.llm.model,
  );
}
