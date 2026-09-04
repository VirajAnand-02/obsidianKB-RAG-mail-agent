import { env, type EmbeddingProvider, type LlmProvider } from "@/lib/env";
import { isDatabaseConfigured, supabaseAdmin } from "@/lib/supabase/admin";
import { createLogger, errorMessage } from "@/lib/logger";
import type { RuntimeConfig } from "@/lib/types";

const log = createLogger("config");

/**
 * Runtime configuration.
 *
 * Resolution order is `app_settings` row -> environment variable -> default.
 * The database layer exists so an admin can retune retrieval or switch LLM
 * provider from the dashboard without a redeploy; `.env` remains the source of
 * truth for anything not yet overridden.
 */

/** Dotted setting key -> value, as stored in `app_settings`. */
type SettingsMap = Record<string, unknown>;

const CACHE_TTL_MS = 15_000;
let cache: { at: number; settings: SettingsMap } | null = null;

async function loadSettings(): Promise<SettingsMap> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.settings;
  if (!isDatabaseConfigured()) return {};

  try {
    const { data, error } = await supabaseAdmin().from("app_settings").select("key, value");
    if (error) throw error;

    const settings: SettingsMap = {};
    for (const row of data ?? []) settings[row.key as string] = row.value;
    cache = { at: Date.now(), settings };
    return settings;
  } catch (e) {
    // A settings outage must not take the whole pipeline down; fall back to env.
    log.warn("Could not read app_settings, falling back to environment", {
      error: errorMessage(e),
    });
    return {};
  }
}

/** Drops the settings cache so the next read reflects a just-saved change. */
export function invalidateConfigCache() {
  cache = null;
}

function pick<T>(settings: SettingsMap, key: string, fallback: T): T {
  const v = settings[key];
  if (v === undefined || v === null || v === "") return fallback;
  return v as T;
}

function pickNum(settings: SettingsMap, key: string, fallback: number): number {
  const v = settings[key];
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickBool(settings: SettingsMap, key: string, fallback: boolean): boolean {
  const v = settings[key];
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "boolean") return v;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const s = await loadSettings();
  return buildConfig(s);
}

/** Synchronous variant for scripts and tests that only need `.env` values. */
export function getEnvConfig(): RuntimeConfig {
  return buildConfig({});
}

function buildConfig(s: SettingsMap): RuntimeConfig {
  return {
    llm: {
      provider: pick(s, "llm.provider", env.LLM_PROVIDER) as LlmProvider,
      model: pick(s, "llm.model", env.LLM_MODEL),
      temperature: pickNum(s, "llm.temperature", env.LLM_TEMPERATURE),
      maxOutputTokens: pickNum(s, "llm.maxOutputTokens", env.LLM_MAX_OUTPUT_TOKENS),
    },
    embedding: {
      provider: pick(s, "embedding.provider", env.EMBEDDING_PROVIDER) as EmbeddingProvider,
      model: pick(s, "embedding.model", env.EMBEDDING_MODEL),
      dimensions: pickNum(s, "embedding.dimensions", env.EMBEDDING_DIMENSIONS),
      batchSize: pickNum(s, "embedding.batchSize", env.EMBEDDING_BATCH_SIZE),
      concurrency: pickNum(s, "embedding.concurrency", env.EMBEDDING_CONCURRENCY),
      docPrefix: pick(s, "embedding.docPrefix", env.EMBEDDING_DOC_PREFIX),
      queryPrefix: pick(s, "embedding.queryPrefix", env.EMBEDDING_QUERY_PREFIX),
    },
    chunking: {
      strategy: pick(s, "chunking.strategy", env.CHUNK_STRATEGY) as "markdown" | "recursive",
      sizeTokens: pickNum(s, "chunking.sizeTokens", env.CHUNK_SIZE_TOKENS),
      overlapTokens: pickNum(s, "chunking.overlapTokens", env.CHUNK_OVERLAP_TOKENS),
      minTokens: pickNum(s, "chunking.minTokens", env.CHUNK_MIN_TOKENS),
      maxTokens: pickNum(s, "chunking.maxTokens", env.CHUNK_MAX_TOKENS),
      prependHeadings: pickBool(s, "chunking.prependHeadings", env.CHUNK_PREPEND_HEADINGS),
      keepCodeBlocks: pickBool(s, "chunking.keepCodeBlocks", env.CHUNK_KEEP_CODE_BLOCKS),
    },
    retrieval: {
      hybrid: pickBool(s, "retrieval.hybrid", env.RAG_HYBRID),
      rrfK: pickNum(s, "retrieval.rrfK", env.RAG_RRF_K),
      candidateK: pickNum(s, "retrieval.candidateK", env.RAG_CANDIDATE_K),
      topK: pickNum(s, "retrieval.topK", env.RAG_TOP_K),
      minScore: pickNum(s, "retrieval.minScore", env.RAG_MIN_SCORE),
      neighborWindow: pickNum(s, "retrieval.neighborWindow", env.RAG_NEIGHBOR_WINDOW),
      queryExpansion: pickBool(s, "retrieval.queryExpansion", env.RAG_QUERY_EXPANSION),
      queryVariants: pickNum(s, "retrieval.queryVariants", env.RAG_QUERY_VARIANTS),
      reranker: pick(s, "retrieval.reranker", env.RAG_RERANKER) as "none" | "cohere" | "jina",
      rerankerModel: pick(s, "retrieval.rerankerModel", env.RAG_RERANKER_MODEL),
      contextTokenBudget: pickNum(s, "retrieval.contextTokenBudget", env.RAG_CONTEXT_TOKEN_BUDGET),
      efSearch: pickNum(s, "retrieval.efSearch", env.PGVECTOR_HNSW_EF_SEARCH),
    },
    grounding: {
      enabled: pickBool(s, "grounding.enabled", env.GROUNDING_ENABLED),
      // Blank means "reuse the generation provider/model".
      provider: pick(s, "grounding.provider", env.GROUNDING_PROVIDER),
      model: pick(s, "grounding.model", env.GROUNDING_MODEL),
      autosendThreshold: pickNum(s, "grounding.autosendThreshold", env.GROUNDING_AUTOSEND_THRESHOLD),
      reviewThreshold: pickNum(s, "grounding.reviewThreshold", env.GROUNDING_REVIEW_THRESHOLD),
      requireCitations: pickBool(s, "grounding.requireCitations", env.GROUNDING_REQUIRE_CITATIONS),
      failMode: pick(s, "grounding.failMode", env.GROUNDING_FAIL_MODE) as
        | "review"
        | "block"
        | "send",
    },
    newsletter: {
      enabled: pickBool(s, "newsletter.enabled", env.NEWSLETTER_ENABLED),
      cron: pick(s, "newsletter.cron", env.NEWSLETTER_CRON),
      timezone: pick(s, "newsletter.timezone", env.NEWSLETTER_TIMEZONE),
      lookbackDays: pickNum(s, "newsletter.lookbackDays", env.NEWSLETTER_LOOKBACK_DAYS),
      maxItems: pickNum(s, "newsletter.maxItems", env.NEWSLETTER_MAX_ITEMS),
      requireApproval: pickBool(s, "newsletter.requireApproval", env.NEWSLETTER_REQUIRE_APPROVAL),
    },
    email: {
      fromEmail: pick(s, "email.fromEmail", env.RESEND_FROM_EMAIL),
      fromName: pick(s, "email.fromName", env.RESEND_FROM_NAME),
      replyTo: pick(s, "email.replyTo", env.RESEND_REPLY_TO),
      dryRun: pickBool(s, "email.dryRun", env.MAIL_DRY_RUN),
      allowedSenderDomains: pick(s, "email.allowedSenderDomains", env.ALLOWED_SENDER_DOMAINS),
      rateLimitPerSenderPerDay: pickNum(
        s,
        "email.rateLimitPerSenderPerDay",
        env.RATE_LIMIT_REPLIES_PER_SENDER_PER_DAY,
      ),
    },
  };
}

/** Writes one setting and clears the cache. */
export async function setSetting(
  key: string,
  value: unknown,
  category: string,
  actor?: string,
): Promise<void> {
  const { error } = await supabaseAdmin().rpc("upsert_setting", {
    p_key: key,
    p_value: value as never,
    p_category: category,
    p_actor: actor ?? null,
  });
  if (error) throw new Error(`Failed to save setting ${key}: ${error.message}`);
  invalidateConfigCache();
}
