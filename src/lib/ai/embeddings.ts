// Must precede every provider import: blank env values break their module init.
import "@/lib/env-normalize";

import { embedMany, type EmbeddingModel } from "ai";
import { createCohere } from "@ai-sdk/cohere";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import pLimit from "p-limit";

import { env, SUPPORTED_DIMENSIONS, type EmbeddingProvider } from "@/lib/env";
import { appConfig } from "@/lib/app-config";
import { getRuntimeConfig } from "@/lib/config";
import { resolveApiKey } from "@/lib/ai/registry";
import { createLogger, errorMessage } from "@/lib/logger";

const log = createLogger("ai:embeddings");

/**
 * Multi-provider embeddings, weighted towards options with a usable free tier.
 *
 * Providers split into two groups:
 *   - SDK-backed (mistral, google, openai, cohere, ollama, openai-compatible)
 *   - plain HTTP (jina, huggingface, voyage) — these have no AI SDK provider,
 *     but their embedding endpoints are simple enough that a fetch wrapper is
 *     less code than a custom provider implementation.
 *
 * Asymmetric models (nomic, e5, bge) score noticeably better when documents and
 * queries get different prefixes, so `kind` is threaded through everywhere.
 */

export type EmbedKind = "document" | "query";

/** Known models, so the settings UI can prefill dimensions and flag free tiers. */
export interface EmbeddingModelInfo {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  free: boolean;
  note?: string;
  docPrefix?: string;
  queryPrefix?: string;
}

export const KNOWN_EMBEDDING_MODELS: EmbeddingModelInfo[] = [
  {
    provider: "mistral",
    model: "mistral-embed",
    dimensions: 1024,
    free: true,
    note: "Free tier available. Strong general-purpose default.",
  },
  {
    provider: "google",
    model: "text-embedding-004",
    dimensions: 768,
    free: true,
    note: "Generous free tier via Google AI Studio.",
  },
  {
    provider: "google",
    model: "gemini-embedding-001",
    dimensions: 1536,
    free: true,
    note: "Free tier. Dimensions are truncatable (768/1536/3072).",
  },
  {
    provider: "ollama",
    model: "nomic-embed-text",
    dimensions: 768,
    free: true,
    note: "Fully local, no API key. Needs `ollama pull nomic-embed-text`.",
    docPrefix: "search_document: ",
    queryPrefix: "search_query: ",
  },
  {
    provider: "ollama",
    model: "mxbai-embed-large",
    dimensions: 1024,
    free: true,
    note: "Local. Higher quality than nomic, slower.",
  },
  {
    provider: "ollama",
    model: "all-minilm",
    dimensions: 384,
    free: true,
    note: "Local, tiny and fast. Lowest quality of the local options.",
  },
  {
    provider: "jina",
    model: "jina-embeddings-v3",
    dimensions: 1024,
    free: true,
    note: "Free tier tokens on signup. Good multilingual performance.",
  },
  {
    provider: "huggingface",
    model: "sentence-transformers/all-MiniLM-L6-v2",
    dimensions: 384,
    free: true,
    note: "Free Inference API. Rate limited; fine for small vaults.",
  },
  {
    provider: "cohere",
    model: "embed-english-v3.0",
    dimensions: 1024,
    free: true,
    note: "Free trial keys are rate limited but unmetered.",
  },
  { provider: "voyage", model: "voyage-3.5-lite", dimensions: 1024, free: true, note: "Large free token allowance." },
  { provider: "openai", model: "text-embedding-3-small", dimensions: 1536, free: false },
  { provider: "openai", model: "text-embedding-3-large", dimensions: 3072, free: false },
];

export function lookupEmbeddingModel(
  provider: string,
  model: string,
): EmbeddingModelInfo | undefined {
  return KNOWN_EMBEDDING_MODELS.find((m) => m.provider === provider && m.model === model);
}

// ---------------------------------------------------------------------------
// SDK-backed providers
// ---------------------------------------------------------------------------

async function sdkModel(provider: EmbeddingProvider, model: string): Promise<EmbeddingModel | null> {
  const apiKey = await resolveApiKey(provider);

  switch (provider) {
    case "mistral":
      return createMistral({ apiKey }).textEmbeddingModel(model);
    case "google":
      return createGoogleGenerativeAI({ apiKey }).textEmbeddingModel(model);
    case "openai":
      return createOpenAI({
        apiKey,
        ...(appConfig.llm.openaiBaseUrl ? { baseURL: appConfig.llm.openaiBaseUrl } : {}),
      }).textEmbeddingModel(model);
    case "cohere":
      return createCohere({ apiKey }).textEmbeddingModel(model);
    case "ollama":
      return createOpenAICompatible({
        name: "ollama",
        baseURL: appConfig.llm.ollamaBaseUrl,
      }).textEmbeddingModel(model);
    case "openai-compatible":
      if (!appConfig.llm.openaiCompatibleBaseUrl) {
        throw new Error("OPENAI_COMPATIBLE_BASE_URL must be set for openai-compatible embeddings.");
      }
      return createOpenAICompatible({
        name: appConfig.llm.openaiCompatibleName,
        baseURL: appConfig.llm.openaiCompatibleBaseUrl,
        ...(apiKey ? { apiKey } : {}),
      }).textEmbeddingModel(model);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP-only providers
// ---------------------------------------------------------------------------

async function embedViaJina(
  texts: string[],
  model: string,
  kind: EmbedKind,
  dimensions: number,
): Promise<number[][]> {
  const apiKey = await resolveApiKey("jina");
  if (!apiKey) throw new Error("JINA_API_KEY is required for the Jina embedding provider.");

  const res = await fetch("https://api.jina.ai/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      // Jina v3 uses task LoRAs; picking the right one is a real quality gain.
      task: kind === "query" ? "retrieval.query" : "retrieval.passage",
      dimensions,
      input: texts,
    }),
  });

  if (!res.ok) throw new Error(`Jina embeddings failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function embedViaVoyage(
  texts: string[],
  model: string,
  kind: EmbedKind,
): Promise<number[][]> {
  const apiKey = await resolveApiKey("voyage");
  if (!apiKey) throw new Error("VOYAGE_API_KEY is required for the Voyage embedding provider.");

  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      input: texts,
      input_type: kind === "query" ? "query" : "document",
    }),
  });

  if (!res.ok) throw new Error(`Voyage embeddings failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function embedViaHuggingFace(texts: string[], model: string): Promise<number[][]> {
  const apiKey = await resolveApiKey("huggingface");
  if (!apiKey) {
    throw new Error("HUGGINGFACE_API_KEY is required for the Hugging Face embedding provider.");
  }

  const res = await fetch(
    `https://api-inference.huggingface.co/pipeline/feature-extraction/${model}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ inputs: texts, options: { wait_for_model: true } }),
    },
  );

  if (!res.ok) {
    throw new Error(`Hugging Face embeddings failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as number[][] | number[][][];
  // Some models return token-level vectors; mean-pool them to one vector per input.
  return (json as unknown[]).map((item) => {
    const first = (item as unknown[])[0];
    if (Array.isArray(first)) {
      const tokens = item as number[][];
      const dim = tokens[0].length;
      const pooled = new Array<number>(dim).fill(0);
      for (const t of tokens) for (let i = 0; i < dim; i++) pooled[i] += t[i];
      return pooled.map((v) => v / tokens.length);
    }
    return item as number[];
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EmbedOptions {
  provider?: EmbeddingProvider;
  model?: string;
  dimensions?: number;
  batchSize?: number;
  concurrency?: number;
  docPrefix?: string;
  queryPrefix?: string;
}

/** Retries transient failures (429/5xx/network) with exponential backoff. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4, label = "embed"): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const msg = errorMessage(e);
      const retryable = /429|rate.?limit|timeout|ECONNRESET|fetch failed|50\d/i.test(msg);
      if (!retryable || i === attempts - 1) throw e;

      // Free tiers rate-limit aggressively, so back off generously.
      const delay = Math.min(30_000, 1500 * 2 ** i) + Math.random() * 500;
      log.warn(`${label} attempt ${i + 1} failed, retrying`, { delayMs: Math.round(delay), error: msg });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/**
 * Embeds a batch of texts with the configured (or given) provider.
 * Returns vectors in the same order as the input.
 */
export async function embedTexts(
  texts: string[],
  kind: EmbedKind = "document",
  options: EmbedOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const config = await getRuntimeConfig();
  const provider = (options.provider ?? config.embedding.provider) as EmbeddingProvider;
  const model = options.model ?? config.embedding.model;
  const dimensions = options.dimensions ?? config.embedding.dimensions;
  const batchSize = Math.max(1, options.batchSize ?? config.embedding.batchSize);
  const concurrency = Math.max(1, options.concurrency ?? config.embedding.concurrency);

  const known = lookupEmbeddingModel(provider, model);
  const docPrefix = options.docPrefix ?? config.embedding.docPrefix ?? known?.docPrefix ?? "";
  const queryPrefix = options.queryPrefix ?? config.embedding.queryPrefix ?? known?.queryPrefix ?? "";
  const prefix = kind === "query" ? queryPrefix : docPrefix;

  const prepared = prefix ? texts.map((t) => prefix + t) : texts;

  const batches: string[][] = [];
  for (let i = 0; i < prepared.length; i += batchSize) {
    batches.push(prepared.slice(i, i + batchSize));
  }

  const limit = pLimit(concurrency);
  const model_ = await sdkModel(provider, model);

  const results = await Promise.all(
    batches.map((batch, batchIndex) =>
      limit(() =>
        withRetry(async () => {
          if (model_) {
            const { embeddings } = await embedMany({
              model: model_,
              values: batch,
              // Providers that support dimension truncation use these; others ignore them.
              providerOptions: {
                openai: { dimensions },
                google: { outputDimensionality: dimensions },
              },
            });
            return embeddings as number[][];
          }

          switch (provider) {
            case "jina":
              return embedViaJina(batch, model, kind, dimensions);
            case "voyage":
              return embedViaVoyage(batch, model, kind);
            case "huggingface":
              return embedViaHuggingFace(batch, model);
            default:
              throw new Error(`Unsupported embedding provider "${provider}".`);
          }
        }, 4, `embed batch ${batchIndex + 1}/${batches.length}`),
      ),
    ),
  );

  const vectors = results.flat();

  // A dimension mismatch would be written into the wrong table and silently
  // corrupt retrieval, so it is worth failing loudly right here.
  if (vectors.length > 0 && vectors[0].length !== dimensions) {
    throw new Error(
      `Embedding dimension mismatch: ${provider}/${model} returned ${vectors[0].length} ` +
        `dimensions but the configuration says ${dimensions}. Update EMBEDDING_DIMENSIONS ` +
        `(or the Settings value) and re-run \`npm run db:reembed\`.`,
    );
  }

  return vectors;
}

/** Convenience wrapper for the single-query case. */
export async function embedQuery(text: string, options: EmbedOptions = {}): Promise<number[]> {
  const [vector] = await embedTexts([text], "query", options);
  return vector;
}

/** Formats a vector as the text literal pgvector accepts (`[0.1,0.2]`). */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export function assertSupportedDimension(dimensions: number) {
  if (!SUPPORTED_DIMENSIONS.includes(dimensions as (typeof SUPPORTED_DIMENSIONS)[number])) {
    throw new Error(
      `Embedding dimension ${dimensions} has no table. Supported: ${SUPPORTED_DIMENSIONS.join(", ")}. ` +
        `Add a table for it in supabase/migrations/0003_embeddings.sql to use this model.`,
    );
  }
}
