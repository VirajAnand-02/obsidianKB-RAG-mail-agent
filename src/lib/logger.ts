import { env } from "@/lib/env";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function enabled(level: Level) {
  const threshold = ORDER[(env.LOG_LEVEL as Level) in ORDER ? (env.LOG_LEVEL as Level) : "info"];
  return ORDER[level] >= threshold;
}

/**
 * Structured logger. Emits JSON in production (parseable by Vercel/Datadog) and
 * a readable single line locally.
 */
function emit(level: Level, scope: string, message: string, data?: Record<string, unknown>) {
  if (!enabled(level)) return;
  const entry = { ts: new Date().toISOString(), level, scope, message, ...data };
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;

  if (env.NODE_ENV === "production") {
    sink(JSON.stringify(entry));
  } else {
    const extra = data && Object.keys(data).length ? ` ${JSON.stringify(data)}` : "";
    sink(`[${level}] ${scope}: ${message}${extra}`);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, d?: Record<string, unknown>) => emit("debug", scope, m, d),
    info: (m: string, d?: Record<string, unknown>) => emit("info", scope, m, d),
    warn: (m: string, d?: Record<string, unknown>) => emit("warn", scope, m, d),
    error: (m: string, d?: Record<string, unknown>) => emit("error", scope, m, d),
    child: (sub: string) => createLogger(`${scope}:${sub}`),
  };
}

export type Logger = ReturnType<typeof createLogger>;
export const logger = createLogger("obsi-relay");

/** Normalises unknown thrown values into a message string. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
