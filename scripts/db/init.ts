import "dotenv/config";
import { migrate } from "./migrate";
import { env } from "@/lib/env";
import { appConfig } from "@/lib/app-config";
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
  const bucket = appConfig.supabase.storageBucket;

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
    fileSizeLimit: `${appConfig.ingestion.maxVaultUploadMb}MB`,
  });

  if (!createError) {
    console.log(`  created storage bucket "${bucket}" (${appConfig.ingestion.maxVaultUploadMb}MB limit)`);
    return;
  }

  // Every Supabase project has a global per-file ceiling, and a bucket may not
  // exceed it. Rather than failing setup over a number the user did not choose,
  // fall back to the project default and say what happened.
  if (/exceeded the maximum allowed size|maximum allowed size/i.test(createError.message)) {
    const { error: retryError } = await db.storage.createBucket(bucket, { public: false });

    if (retryError) {
      throw new Error(`Could not create bucket "${bucket}": ${retryError.message}`);
    }

    console.log(`  created storage bucket "${bucket}" using the project default size limit`);
    console.warn(
      `  ! appConfig.ingestion.maxVaultUploadMb is ${appConfig.ingestion.maxVaultUploadMb}, above your project's per-file\n` +
        "    ceiling. Larger vaults will be rejected by Storage. Either lower\n" +
        "    MAX_VAULT_UPLOAD_MB, raise the limit in Supabase -> Storage -> Settings,\n" +
        "    or ingest locally with `npm run vault:ingest -- <path>`, which does not\n" +
        "    use Storage at all.",
    );
    return;
  }

  throw new Error(`Could not create bucket "${bucket}": ${createError.message}`);
}

async function seedSettings() {
  const db = supabaseAdmin();

  // Dashboard sign-in reads ADMIN_EMAIL directly from the environment; this row
  // exists only for the SQL `is_admin()` function behind the RLS policies, which
  // gate direct database access rather than the app.
  const defaults: { key: string; value: unknown; category: string }[] = [
    { key: "admin_emails", value: env.ADMIN_EMAIL ? [env.ADMIN_EMAIL] : [], category: "auth" },
    { key: "llm.provider", value: appConfig.llm.provider, category: "llm" },
    { key: "llm.model", value: appConfig.llm.model, category: "llm" },
    { key: "embedding.provider", value: appConfig.embedding.provider, category: "embedding" },
    { key: "embedding.model", value: appConfig.embedding.model, category: "embedding" },
    { key: "embedding.dimensions", value: appConfig.embedding.dimensions, category: "embedding" },
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

  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    console.warn(
      "  ! ADMIN_EMAIL and/or ADMIN_PASSWORD are not set, so nobody can sign in to the\n" +
        "    dashboard once it is deployed. Add them to .env and re-run this command.\n",
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
