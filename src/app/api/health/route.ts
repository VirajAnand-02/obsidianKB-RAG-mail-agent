import { NextResponse } from "next/server";
import { checkReadiness } from "@/lib/env";
import { getAdmin } from "@/lib/auth";
import { getRuntimeConfig } from "@/lib/config";
import { isDatabaseConfigured, supabaseAdmin } from "@/lib/supabase/admin";
import { errorMessage } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness probe.
 *
 * Unauthenticated callers get a bare up/down, because the detail below names
 * which environment variables are set and which provider and model are in use —
 * that is a map of the deployment, and it should not be readable by anyone who
 * finds the URL. Signed-in admins get the full report.
 */
export async function GET() {
  const admin = await getAdmin();
  const readiness = checkReadiness();

  if (!admin) {
    return NextResponse.json(
      { ok: readiness.ok, status: readiness.ok ? "ready" : "incomplete" },
      { status: readiness.ok ? 200 : 503 },
    );
  }

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
