import { z } from "zod";

/**
 * Environment schema for Obsi-Relay.
 *
 * Everything is parsed leniently with defaults so the app boots with a partly
 * filled `.env` and can tell the user what is missing in the dashboard, rather
 * than crashing at import time. Hard requirements are asserted at the point of
 * use via `requireEnv`.
 */

const bool = (fallback: boolean) =>
  z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return fallback;
      if (typeof v === "boolean") return v;
      return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
    });

const num = (fallback: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return fallback;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : fallback;
    });

const str = (fallback = "") =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : v.trim()));

/** Comma-separated list -> string[], with blanks dropped. */
const list = (fallback: string[] = []) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ""
        ? fallback
        : v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    );

export const LLM_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "mistral",
  "groq",
  "deepseek",
  "xai",
  "cohere",
  "azure",
  "openrouter",
  "ollama",
  "openai-compatible",
] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const EMBEDDING_PROVIDERS = [
  "mistral",
  "google",
  "openai",
  "cohere",
  "ollama",
  "jina",
  "huggingface",
  "voyage",
  "openai-compatible",
] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

/** Dimensions with a physical table in 0003_embeddings.sql. */
export const SUPPORTED_DIMENSIONS = [384, 512, 768, 1024, 1536, 3072] as const;

const schema = z.object({
  NODE_ENV: str("development"),
  NEXT_PUBLIC_APP_URL: str("http://localhost:3000"),
  NEXT_PUBLIC_APP_NAME: str("Obsi-Relay"),
  CRON_SECRET: str(),
  SETTINGS_ENCRYPTION_KEY: str(),

  NEXT_PUBLIC_SUPABASE_URL: str(),
  // Supabase renamed the browser key: new projects issue a "publishable key"
  // (sb_publishable_...) where older ones issued an "anon key" (a JWT). Both
  // names are accepted so either dashboard vintage works.
  NEXT_PUBLIC_SUPABASE_ANON_KEY: str(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: str(),
  // Likewise the server key: "secret key" (sb_secret_...) or "service_role".
  SUPABASE_SERVICE_ROLE_KEY: str(),
  SUPABASE_SECRET_KEY: str(),
  SUPABASE_DB_URL: str(),
  SUPABASE_STORAGE_BUCKET: str("vaults"),

  ADMIN_EMAILS: list(),

  // ---- generation ----
  LLM_PROVIDER: str("mistral"),
  LLM_MODEL: str("mistral-large-latest"),
  LLM_TEMPERATURE: num(0.2),
  LLM_MAX_OUTPUT_TOKENS: num(2000),
  LLM_REQUEST_TIMEOUT_MS: num(60_000),

  OPENAI_API_KEY: str(),
  OPENAI_BASE_URL: str(),
  ANTHROPIC_API_KEY: str(),
  GOOGLE_GENERATIVE_AI_API_KEY: str(),
  MISTRAL_API_KEY: str(),
  GROQ_API_KEY: str(),
  DEEPSEEK_API_KEY: str(),
  XAI_API_KEY: str(),
  COHERE_API_KEY: str(),
  OPENROUTER_API_KEY: str(),
  AZURE_API_KEY: str(),
  AZURE_RESOURCE_NAME: str(),
  AZURE_API_VERSION: str("2024-10-21"),
  OLLAMA_BASE_URL: str("http://localhost:11434/v1"),
  OPENAI_COMPATIBLE_NAME: str("custom"),
  OPENAI_COMPATIBLE_BASE_URL: str(),
  OPENAI_COMPATIBLE_API_KEY: str(),

  // ---- embeddings ----
  EMBEDDING_PROVIDER: str("mistral"),
  EMBEDDING_MODEL: str("mistral-embed"),
  EMBEDDING_DIMENSIONS: num(1024),
  EMBEDDING_BATCH_SIZE: num(64),
  EMBEDDING_CONCURRENCY: num(3),
  EMBEDDING_DOC_PREFIX: str(),
  EMBEDDING_QUERY_PREFIX: str(),
  JINA_API_KEY: str(),
  HUGGINGFACE_API_KEY: str(),
  VOYAGE_API_KEY: str(),

  // ---- chunking ----
  CHUNK_STRATEGY: str("markdown"),
  CHUNK_SIZE_TOKENS: num(512),
  CHUNK_OVERLAP_TOKENS: num(64),
  CHUNK_MIN_TOKENS: num(48),
  CHUNK_MAX_TOKENS: num(1024),
  CHUNK_PREPEND_HEADINGS: bool(true),
  CHUNK_KEEP_CODE_BLOCKS: bool(true),

  // ---- retrieval ----
  RAG_HYBRID: bool(true),
  RAG_RRF_K: num(60),
  RAG_CANDIDATE_K: num(40),
  RAG_TOP_K: num(8),
  RAG_MIN_SCORE: num(0.2),
  RAG_NEIGHBOR_WINDOW: num(1),
  RAG_QUERY_EXPANSION: bool(true),
  RAG_QUERY_VARIANTS: num(3),
  RAG_RERANKER: str("none"),
  RAG_RERANKER_MODEL: str("rerank-v3.5"),
  RAG_CONTEXT_TOKEN_BUDGET: num(6000),
  PGVECTOR_HNSW_M: num(16),
  PGVECTOR_HNSW_EF_CONSTRUCTION: num(64),
  PGVECTOR_HNSW_EF_SEARCH: num(100),

  // ---- ingestion ----
  MAX_VAULT_UPLOAD_MB: num(200),
  INGEST_CONCURRENCY: num(6),
  INGEST_EXCLUDE_GLOBS: list([
    ".obsidian/**",
    ".trash/**",
    ".git/**",
    "**/node_modules/**",
  ]),
  INGEST_RESPECT_PRIVACY_FRONTMATTER: bool(true),
  INGEST_PRIVATE_TAGS: list(["private", "secret", "noindex"]),

  // ---- email ----
  RESEND_API_KEY: str(),
  RESEND_FROM_EMAIL: str(),
  RESEND_FROM_NAME: str("Obsi-Relay"),
  RESEND_REPLY_TO: str(),
  RESEND_INBOUND_DOMAIN: str(),
  RESEND_WEBHOOK_SECRET: str(),
  RESEND_AUDIENCE_ID: str(),
  MAIL_DRY_RUN: bool(true),
  ALLOWED_SENDER_DOMAINS: list(),
  RATE_LIMIT_REPLIES_PER_SENDER_PER_DAY: num(10),

  // ---- grounding ----
  GROUNDING_ENABLED: bool(true),
  GROUNDING_PROVIDER: str(),
  GROUNDING_MODEL: str(),
  GROUNDING_AUTOSEND_THRESHOLD: num(0.8),
  GROUNDING_REVIEW_THRESHOLD: num(0.5),
  GROUNDING_REQUIRE_CITATIONS: bool(true),
  GROUNDING_FAIL_MODE: str("review"),

  // ---- newsletter ----
  NEWSLETTER_ENABLED: bool(false),
  NEWSLETTER_CRON: str("0 9 * * MON"),
  NEWSLETTER_TIMEZONE: str("UTC"),
  NEWSLETTER_LOOKBACK_DAYS: num(7),
  NEWSLETTER_MAX_ITEMS: num(6),
  NEWSLETTER_REQUIRE_APPROVAL: bool(true),

  // ---- evaluator ----
  EVAL_JUDGE_PROVIDER: str(),
  EVAL_JUDGE_MODEL: str(),
  EVAL_DATASET: str("src/evaluator/datasets/golden.jsonl"),
  EVAL_OUTPUT_DIR: str("eval-results"),
  EVAL_CONCURRENCY: num(4),
  EVAL_REPEATS: num(1),
  EVAL_PASS_THRESHOLD: num(0.7),

  LOG_LEVEL: str("info"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Should be unreachable: every field has a default. Surface it loudly anyway.
    throw new Error(
      `Invalid environment configuration:\n${z.prettifyError(parsed.error)}`,
    );
  }
  cached = parsed.data;
  return cached;
}

/** Test hook: forces the next getEnv() to re-read process.env. */
export function resetEnvCache() {
  cached = null;
}

export const env: Env = new Proxy({} as Env, {
  get: (_t, prop: string) => getEnv()[prop as keyof Env],
  ownKeys: () => Reflect.ownKeys(getEnv()),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});

/** Asserts a variable is set, with a message naming the feature that needs it. */
export function requireEnv<K extends keyof Env>(key: K, feature: string): NonNullable<Env[K]> {
  const value = getEnv()[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(
      `Missing required environment variable ${String(key)} (needed for: ${feature}). ` +
        `Add it to .env — see .env.example for the description.`,
    );
  }
  return value as NonNullable<Env[K]>;
}

/**
 * The browser-side Supabase key, under whichever name the project uses.
 * `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is the current name; the older
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY` still works.
 */
export function supabaseBrowserKey(): string {
  const e = getEnv();
  return e.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || e.NEXT_PUBLIC_SUPABASE_ANON_KEY;
}

/** The server-side Supabase key, under whichever name the project uses. */
export function supabaseServerKey(): string {
  const e = getEnv();
  return e.SUPABASE_SECRET_KEY || e.SUPABASE_SERVICE_ROLE_KEY;
}

/** Non-throwing readiness probe used by /api/health and the dashboard banner. */
export function checkReadiness() {
  const e = getEnv();
  const checks: { key: string; ok: boolean; feature: string }[] = [
    { key: "NEXT_PUBLIC_SUPABASE_URL", ok: !!e.NEXT_PUBLIC_SUPABASE_URL, feature: "database" },
    {
      key: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      ok: !!supabaseBrowserKey(),
      feature: "dashboard sign-in",
    },
    { key: "SUPABASE_SECRET_KEY", ok: !!supabaseServerKey(), feature: "database" },
    { key: "SUPABASE_DB_URL", ok: !!e.SUPABASE_DB_URL, feature: "migrations" },
    { key: "RESEND_API_KEY", ok: !!e.RESEND_API_KEY, feature: "sending email" },
    { key: "RESEND_FROM_EMAIL", ok: !!e.RESEND_FROM_EMAIL, feature: "sending email" },
    { key: "RESEND_WEBHOOK_SECRET", ok: !!e.RESEND_WEBHOOK_SECRET, feature: "inbound email" },
    { key: "CRON_SECRET", ok: !!e.CRON_SECRET, feature: "scheduled newsletters" },
    { key: "SETTINGS_ENCRYPTION_KEY", ok: !!e.SETTINGS_ENCRYPTION_KEY, feature: "storing keys in the UI" },
  ];
  return { ok: checks.every((c) => c.ok), checks: checks.filter((c) => !c.ok), all: checks };
}
