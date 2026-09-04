import { z } from "zod";
import { appConfig } from "@/lib/app-config";

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
  SETTINGS_ENCRYPTION_KEY: str(),

  // Server key. Newer projects call this the "secret key" (sb_secret_...);
  // older ones the "service_role" JWT. Both names are accepted.
  SUPABASE_SERVICE_ROLE_KEY: str(),
  SUPABASE_SECRET_KEY: str(),
  SUPABASE_DB_URL: str(),

  // ---- dashboard sign-in (single admin account) ----
  ADMIN_EMAIL: str(),
  ADMIN_PASSWORD: str(),
  // Signs the session cookie. Falls back to SETTINGS_ENCRYPTION_KEY.
  AUTH_SECRET: str(),
  // ---- provider credentials ----
  OPENAI_API_KEY: str(),
  ANTHROPIC_API_KEY: str(),
  GOOGLE_GENERATIVE_AI_API_KEY: str(),
  MISTRAL_API_KEY: str(),
  GROQ_API_KEY: str(),
  DEEPSEEK_API_KEY: str(),
  XAI_API_KEY: str(),
  COHERE_API_KEY: str(),
  OPENROUTER_API_KEY: str(),
  AZURE_API_KEY: str(),
  OPENAI_COMPATIBLE_API_KEY: str(),
  JINA_API_KEY: str(),
  HUGGINGFACE_API_KEY: str(),
  VOYAGE_API_KEY: str(),
  RESEND_API_KEY: str(),
  RESEND_WEBHOOK_SECRET: str(),
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

/** The server-side Supabase key, under whichever name the project uses. */
export function supabaseServerKey(): string {
  const e = getEnv();
  return e.SUPABASE_SECRET_KEY || e.SUPABASE_SERVICE_ROLE_KEY;
}

/** Non-throwing readiness probe used by /api/health and the dashboard banner. */
export function checkReadiness() {
  const e = getEnv();
  const checks: { key: string; ok: boolean; feature: string }[] = [
    { key: "NEXT_PUBLIC_SUPABASE_URL", ok: !!appConfig.supabase.url, feature: "database" },
    { key: "ADMIN_EMAIL", ok: !!e.ADMIN_EMAIL, feature: "dashboard sign-in" },
    { key: "ADMIN_PASSWORD", ok: !!e.ADMIN_PASSWORD, feature: "dashboard sign-in" },
    { key: "SUPABASE_SECRET_KEY", ok: !!supabaseServerKey(), feature: "database" },
    { key: "SUPABASE_DB_URL", ok: !!e.SUPABASE_DB_URL, feature: "migrations" },
    { key: "RESEND_API_KEY", ok: !!e.RESEND_API_KEY, feature: "sending email" },
    { key: "RESEND_FROM_EMAIL", ok: !!appConfig.email.fromEmail, feature: "sending email" },
    { key: "RESEND_WEBHOOK_SECRET", ok: !!e.RESEND_WEBHOOK_SECRET, feature: "inbound email" },
    { key: "SETTINGS_ENCRYPTION_KEY", ok: !!e.SETTINGS_ENCRYPTION_KEY, feature: "storing keys in the UI" },
  ];
  return { ok: checks.every((c) => c.ok), checks: checks.filter((c) => !c.ok), all: checks };
}
