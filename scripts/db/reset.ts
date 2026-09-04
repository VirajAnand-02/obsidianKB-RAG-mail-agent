import "dotenv/config";
import { createInterface } from "node:readline/promises";
import pg from "pg";
import { env } from "@/lib/env";
import { normaliseDbUrl, redact, SSL_CONFIG } from "@/lib/db-url";
import { errorMessage } from "@/lib/logger";

/**
 * Destructive reset.
 *
 * Two modes:
 *   --content  deletes vaults, notes, chunks, embeddings and email history,
 *              keeping the schema and settings. This is the one you usually want.
 *   --schema   drops every table and function, so the next `db:init` rebuilds
 *              from nothing.
 *
 * Requires an interactive confirmation unless `--yes` is passed, because there
 * is no undo and the notes may be the only copy.
 */

const CONTENT_TABLES = [
  "eval_results",
  "eval_runs",
  "review_actions",
  "outbound_emails",
  "inbound_emails",
  "email_threads",
  "newsletter_issues",
  "query_logs",
  "ingest_runs",
  // Chunks and embeddings cascade from notes/vaults, but truncating explicitly
  // keeps the operation obvious in the log.
  "embeddings_384",
  "embeddings_512",
  "embeddings_768",
  "embeddings_1024",
  "embeddings_1536",
  "embeddings_3072",
  "chunks",
  "notes",
  "vaults",
];

const SCHEMA_OBJECTS = {
  tables: [
    ...CONTENT_TABLES,
    "newsletter_subscribers",
    "embedding_spaces",
    "provider_credentials",
    "app_settings",
    "workspaces",
    "_migrations",
  ],
  types: ["vault_source", "vault_status", "message_status", "delivery_status", "grounding_verdict", "message_kind"],
  functions: [
    "hybrid_search",
    "chunk_neighbors",
    "recent_notes",
    "embedding_table_for",
    "active_embedding_space",
    "activate_embedding_space",
    "embedding_coverage",
    "replies_sent_today",
    "eval_run_summary",
    "upsert_setting",
    "unsubscribe_by_token",
    "is_admin",
    "set_updated_at",
  ],
};

async function confirm(mode: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const target = env.NEXT_PUBLIC_SUPABASE_URL || redact(env.SUPABASE_DB_URL) || "unknown";

  console.log(`\n  This will ${mode} on:\n    ${target}\n`);
  const answer = await rl.question('  Type "reset" to continue: ');
  rl.close();

  return answer.trim().toLowerCase() === "reset";
}

async function main() {
  const args = process.argv.slice(2);
  const schemaMode = args.includes("--schema");
  const skipPrompt = args.includes("--yes");

  const { url: connectionString } = normaliseDbUrl(env.SUPABASE_DB_URL);

  const description = schemaMode
    ? "DROP every table, type and function"
    : "DELETE all vaults, notes, chunks, embeddings and email history";

  if (!skipPrompt && !(await confirm(description))) {
    console.log("\n  Cancelled.\n");
    return;
  }

  const client = new pg.Client({ connectionString, ssl: SSL_CONFIG });
  await client.connect();

  try {
    if (schemaMode) {
      console.log("\n  Dropping schema objects...");
      await client.query("begin");

      for (const fn of SCHEMA_OBJECTS.functions) {
        await client.query(`drop function if exists ${fn} cascade;`);
      }
      for (const table of SCHEMA_OBJECTS.tables) {
        await client.query(`drop table if exists ${table} cascade;`);
      }
      for (const type of SCHEMA_OBJECTS.types) {
        await client.query(`drop type if exists ${type} cascade;`);
      }

      await client.query("commit");
      console.log("  Schema dropped. Run `npm run db:init` to rebuild.\n");
    } else {
      console.log("\n  Clearing content...");
      // One statement so foreign keys never see a partially-cleared state.
      await client.query(`truncate ${CONTENT_TABLES.join(", ")} restart identity cascade;`);
      console.log("  Content cleared. Schema, settings and subscribers were kept.\n");
    }
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`\nReset failed: ${errorMessage(e)}\n`);
  process.exit(1);
});
