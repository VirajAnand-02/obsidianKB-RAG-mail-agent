import { NextResponse } from "next/server";
import { checkReadiness } from "@/lib/env";
import { getRuntimeConfig } from "@/lib/config";
import { isDatabaseConfigured, supabaseAdmin } from "@/lib/supabase/admin";
import { errorMessage } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness probe. Reports which pieces of configuration are still missing so
 * setup problems surface here rather than as a failed email hours later.
 */
export async function GET() {
  const readiness = checkReadiness();

  let database: { ok: boolean; error?: string; vaults?: number; chunks?: number } = { ok: false };

  if (isDatabaseConfigured()) {
    try {
      const db = supabaseAdmin();
      const [{ count: vaults }, { count: chunks }] = await Promise.all([
        db.from("vaults").select("id", { count: "exact", head: true }),
        db.from("chunks").select("id", { count: "exact", head: true }),
      ]);
      database = { ok: true, vaults: vaults ?? 0, chunks: chunks ?? 0 };
    } catch (e) {
      database = { ok: false, error: errorMessage(e) };
    }
  } else {
    database = { ok: false, error: "Supabase credentials are not set" };
  }

  let config: Record<string, unknown> = {};
  try {
    const runtime = await getRuntimeConfig();
    config = {
      llm: `${runtime.llm.provider}/${runtime.llm.model}`,
      embedding: `${runtime.embedding.provider}/${runtime.embedding.model} (${runtime.embedding.dimensions}d)`,
      grounding: runtime.grounding.enabled ? "enabled" : "disabled",
      mailDryRun: runtime.email.dryRun,
    };
  } catch (e) {
    config = { error: errorMessage(e) };
  }

  const ok = readiness.ok && database.ok;

  return NextResponse.json(
    {
      ok,
      status: ok ? "ready" : "incomplete",
      missing: readiness.checks.map((c) => ({ key: c.key, neededFor: c.feature })),
      database,
      config,
      timestamp: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
