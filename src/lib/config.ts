import { appConfig } from "@/lib/app-config";
import type { EmbeddingProvider, LlmProvider } from "@/lib/env";
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
        provider: pick(s, "llm.provider", appConfig.llm.provider) as LlmProvider,
        model: pick(s, "llm.model", appConfig.llm.model),
        temperature: pickNum(s, "llm.temperature", appConfig.llm.temperature),
        maxOutputTokens: pickNum(s, "llm.maxOutputTokens", appConfig.llm.maxOutputTokens),
    },
    embedding: {
        provider: pick(s, "embedding.provider", appConfig.embedding.provider) as EmbeddingProvider,
        model: pick(s, "embedding.model", appConfig.embedding.model),
        dimensions: pickNum(s, "embedding.dimensions", appConfig.embedding.dimensions),
        batchSize: pickNum(s, "embedding.batchSize", appConfig.embedding.batchSize),
        concurrency: pickNum(s, "embedding.concurrency", appConfig.embedding.concurrency),
        docPrefix: pick(s, "embedding.docPrefix", appConfig.embedding.docPrefix),
        queryPrefix: pick(s, "embedding.queryPrefix", appConfig.embedding.queryPrefix),
    },
    chunking: {
        strategy: pick(s, "chunking.strategy", appConfig.chunking.strategy) as "markdown" | "recursive",
        sizeTokens: pickNum(s, "chunking.sizeTokens", appConfig.chunking.sizeTokens),
        overlapTokens: pickNum(s, "chunking.overlapTokens", appConfig.chunking.overlapTokens),
        minTokens: pickNum(s, "chunking.minTokens", appConfig.chunking.minTokens),
        maxTokens: pickNum(s, "chunking.maxTokens", appConfig.chunking.maxTokens),
        prependHeadings: pickBool(s, "chunking.prependHeadings", appConfig.chunking.prependHeadings),
        keepCodeBlocks: pickBool(s, "chunking.keepCodeBlocks", appConfig.chunking.keepCodeBlocks),
    },
    retrieval: {
        hybrid: pickBool(s, "retrieval.hybrid", appConfig.retrieval.hybrid),
        rrfK: pickNum(s, "retrieval.rrfK", appConfig.retrieval.rrfK),
        candidateK: pickNum(s, "retrieval.candidateK", appConfig.retrieval.candidateK),
        topK: pickNum(s, "retrieval.topK", appConfig.retrieval.topK),
        minScore: pickNum(s, "retrieval.minScore", appConfig.retrieval.minScore),
        neighborWindow: pickNum(s, "retrieval.neighborWindow", appConfig.retrieval.neighborWindow),
        queryExpansion: pickBool(s, "retrieval.queryExpansion", appConfig.retrieval.queryExpansion),
        queryVariants: pickNum(s, "retrieval.queryVariants", appConfig.retrieval.queryVariants),
        reranker: pick(s, "retrieval.reranker", appConfig.retrieval.reranker) as "none" | "cohere" | "jina",
        rerankerModel: pick(s, "retrieval.rerankerModel", appConfig.retrieval.rerankerModel),
        contextTokenBudget: pickNum(s, "retrieval.contextTokenBudget", appConfig.retrieval.contextTokenBudget),
        efSearch: pickNum(s, "retrieval.efSearch", appConfig.retrieval.hnswEfSearch),
    },
    grounding: {
        enabled: pickBool(s, "grounding.enabled", appConfig.grounding.enabled),
      // Blank means "reuse the generation provider/model".
        provider: pick(s, "grounding.provider", appConfig.grounding.provider),
        model: pick(s, "grounding.model", appConfig.grounding.model),
        autosendThreshold: pickNum(s, "grounding.autosendThreshold", appConfig.grounding.autosendThreshold),
        reviewThreshold: pickNum(s, "grounding.reviewThreshold", appConfig.grounding.reviewThreshold),
        requireCitations: pickBool(s, "grounding.requireCitations", appConfig.grounding.requireCitations),
        failMode: pick(s, "grounding.failMode", appConfig.grounding.failMode) as
        | "review"
        | "block"
        | "send",
    },
    email: {
      fromEmail: pick(s, "email.fromEmail", appConfig.email.fromEmail),
      fromName: pick(s, "email.fromName", appConfig.email.fromName),
      replyTo: pick(s, "email.replyTo", appConfig.email.replyTo),
      dryRun: pickBool(s, "email.dryRun", appConfig.email.dryRun),
      allowedSenderDomains: pick(s, "email.allowedSenderDomains", appConfig.email.allowedSenderDomains),
      rateLimitPerSenderPerDay: pickNum(s, "email.rateLimitPerSenderPerDay", appConfig.email.rateLimitPerSenderPerDay),
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
