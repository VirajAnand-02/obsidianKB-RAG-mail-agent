import "dotenv/config";
import pg from "pg";
import { env, checkReadiness } from "@/lib/env";
import { getRuntimeConfig } from "@/lib/config";
import { normaliseDbUrl, DbUrlError, SSL_CONFIG } from "@/lib/db-url";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { errorMessage } from "@/lib/logger";

/**
 * Prints what is configured, what is migrated, and what is indexed.
 * The first thing to run when something is not behaving as expected.
 */
async function main() {
  console.log("\nObsi-Relay status\n");

  // ---- environment ---------------------------------------------------------
  const readiness = checkReadiness();
  console.log("Environment");
  for (const check of readiness.all) {
    console.log(`  ${check.ok ? "✓" : "✗"} ${check.key.padEnd(28)} ${check.feature}`);
  }
  console.log();

  // ---- migrations ----------------------------------------------------------
  let connectionString: string | null = null;
  try {
    connectionString = normaliseDbUrl(env.SUPABASE_DB_URL).url;
  } catch (e) {
    if (e instanceof DbUrlError) console.log(`Migrations
  ! ${e.message}
`);
    else throw e;
  }

  if (connectionString) {
    const client = new pg.Client({ connectionString, ssl: SSL_CONFIG });

    try {
      await client.connect();
      const { rows } = await client.query<{ name: string; applied_at: Date }>(
        "select name, applied_at from _migrations order by name",
      );
      console.log(`Migrations (${rows.length} applied)`);
      for (const row of rows) {
        console.log(`  ✓ ${row.name.padEnd(28)} ${row.applied_at.toISOString().slice(0, 19)}`);
      }
    } catch (e) {
      console.log(`Migrations\n  ! ${errorMessage(e)}`);
      console.log("  Run `npm run db:migrate` if the _migrations table does not exist yet.");
    } finally {
      await client.end().catch(() => {});
    }
    console.log();
  }

  // ---- content -------------------------------------------------------------
  try {
    const db = supabaseAdmin();
    const [notes, chunks, vaults, pending, spaces] = await Promise.all([
      db.from("notes").select("id", { count: "exact", head: true }).is("deleted_at", null),
      db.from("chunks").select("id", { count: "exact", head: true }),
      db.from("vaults").select("name, status, is_default, stats"),
      db
        .from("outbound_emails")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending_review"),
      db.from("embedding_spaces").select("provider, model, dimensions, is_active"),
    ]);

    console.log("Content");
    console.log(`  notes            ${notes.count ?? 0}`);
    console.log(`  chunks           ${chunks.count ?? 0}`);
    console.log(`  awaiting review  ${pending.count ?? 0}`);
    console.log();

    const active = (spaces.data ?? []).find((s) => s.is_active);
    console.log("Embedding space");
    console.log(
      active
        ? `  ${active.provider}/${active.model} (${active.dimensions}d)`
        : "  none active — run `npm run db:init`",
    );
    console.log();

    // Settings stored in the database win over .env, which is easy to forget
    // after changing a value in .env and seeing no effect. Show what is actually
    // in force, and flag the ones being overridden.
    const config = await getRuntimeConfig();
    const overrides: Record<string, string> = {
      "llm.provider": env.LLM_PROVIDER,
      "llm.model": env.LLM_MODEL,
      "embedding.provider": env.EMBEDDING_PROVIDER,
      "embedding.model": env.EMBEDDING_MODEL,
    };
    const effective: Record<string, string> = {
      "llm.provider": config.llm.provider,
      "llm.model": config.llm.model,
      "embedding.provider": config.embedding.provider,
      "embedding.model": config.embedding.model,
    };

    console.log("Effective configuration  (app_settings overrides .env)");
    let shadowed = false;
    for (const [key, envValue] of Object.entries(overrides)) {
      const value = effective[key];
      const differs = value !== envValue;
      if (differs) shadowed = true;
      console.log(
        `  ${key.padEnd(20)} ${value}${differs ? `   <- overriding .env (${envValue})` : ""}`,
      );
    }
    if (shadowed) {
      console.log(
        "\n  A database setting is shadowing .env. Change it in the dashboard Settings\n" +
          "  page, or re-run `npm run db:init` to re-seed these keys from .env.",
      );
    }
    console.log();

    if ((vaults.data ?? []).length > 0) {
      console.log("Vaults");
      for (const vault of vaults.data ?? []) {
        const stats = (vault.stats ?? {}) as Record<string, number>;
        console.log(
          `  ${(vault.name as string).padEnd(24)} ${(vault.status as string).padEnd(10)} ` +
            `${stats.notes ?? 0} notes, ${stats.chunks ?? 0} chunks` +
            `${vault.is_default ? "  (default)" : ""}`,
        );
      }
      console.log();
    }
  } catch (e) {
    console.log(`Content\n  ! ${errorMessage(e)}\n`);
  }
}

main().catch((e) => {
  console.error(`\nStatus check failed: ${errorMessage(e)}\n`);
  process.exit(1);
});
