import "dotenv/config";
import { migrate } from "./migrate";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getWorkspaceId } from "@/lib/workspace";
import { ensureEmbeddingSpace } from "@/lib/rag/indexer";
import { errorMessage } from "@/lib/logger";

/**
 * One-command setup: migrate, create the storage bucket, seed the default
 * workspace and settings, and register the configured embedding space.
 *
 * Safe to re-run — every step is idempotent — so it doubles as the repair path
 * when something was configured after the first run.
 */

async function ensureBucket() {
  const db = supabaseAdmin();
  const bucket = env.SUPABASE_STORAGE_BUCKET;

  const { data: buckets, error } = await db.storage.listBuckets();
  if (error) throw new Error(`Could not list storage buckets: ${error.message}`);

  if (buckets?.some((b) => b.name === bucket)) {
    console.log(`  storage bucket "${bucket}" already exists`);
    return;
  }

  // Private: vault archives contain the user's notes and must never be
  // publicly readable.
  const { error: createError } = await db.storage.createBucket(bucket, {
    public: false,
    fileSizeLimit: `${env.MAX_VAULT_UPLOAD_MB}MB`,
  });

  if (createError) throw new Error(`Could not create bucket "${bucket}": ${createError.message}`);
  console.log(`  created storage bucket "${bucket}"`);
}

async function seedSettings() {
  const db = supabaseAdmin();

  // admin_emails is mirrored into the database because the RLS `is_admin()`
  // function reads it from there, not from the environment.
  const defaults: { key: string; value: unknown; category: string }[] = [
    { key: "admin_emails", value: env.ADMIN_EMAILS, category: "auth" },
    { key: "llm.provider", value: env.LLM_PROVIDER, category: "llm" },
    { key: "llm.model", value: env.LLM_MODEL, category: "llm" },
    { key: "embedding.provider", value: env.EMBEDDING_PROVIDER, category: "embedding" },
    { key: "embedding.model", value: env.EMBEDDING_MODEL, category: "embedding" },
    { key: "embedding.dimensions", value: env.EMBEDDING_DIMENSIONS, category: "embedding" },
  ];

  for (const setting of defaults) {
    const { error } = await db.rpc("upsert_setting", {
      p_key: setting.key,
      p_value: setting.value as never,
      p_category: setting.category,
      p_actor: "db:init",
    });
    if (error) throw new Error(`Could not seed setting ${setting.key}: ${error.message}`);
  }

  console.log(`  seeded ${defaults.length} settings`);
}

async function main() {
  console.log("\nInitialising Obsi-Relay\n");

  console.log("1. Applying migrations");
  const { applied, skipped } = await migrate();
  console.log(`   ${applied.length} applied, ${skipped.length} already up to date\n`);

  console.log("2. Storage");
  await ensureBucket();
  console.log();

  console.log("3. Workspace");
  const workspaceId = await getWorkspaceId();
  console.log(`  workspace ${workspaceId}\n`);

  console.log("4. Settings");
  await seedSettings();
  console.log();

  console.log("5. Embedding space");
  const space = await ensureEmbeddingSpace();
  console.log(`  active: ${space.provider}/${space.model} (${space.dimensions}d)\n`);

  if (env.ADMIN_EMAILS.length === 0) {
    console.warn(
      "  ! ADMIN_EMAILS is empty, so nobody can sign in to the dashboard.\n" +
        "    Add your address to .env and re-run this command.\n",
    );
  }

  console.log("Done. Next:");
  console.log("  npm run dev            start the app");
  console.log("  npm run db:seed        load a small sample vault to try it out");
  console.log("  Upload your vault at   http://localhost:3000/dashboard/vault\n");
}

main().catch((e) => {
  console.error(`\nSetup failed: ${errorMessage(e)}\n`);
  process.exit(1);
});
