import "dotenv/config";
import { reembedVault, ensureEmbeddingSpace } from "@/lib/rag/indexer";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getDefaultVaultId } from "@/lib/workspace";
import { errorMessage } from "@/lib/logger";

/**
 * Regenerates embeddings for every chunk against the currently configured model.
 *
 * Run this after changing EMBEDDING_PROVIDER/EMBEDDING_MODEL. Chunk text is
 * untouched — only the vectors are rebuilt, into the table matching the new
 * model's dimension. The old vectors stay in their own space, so switching back
 * costs nothing.
 */
async function main() {
  const args = process.argv.slice(2);
  const allVaults = args.includes("--all");
  const vaultArg = args.find((a) => !a.startsWith("--"));

  const db = supabaseAdmin();
  const space = await ensureEmbeddingSpace();

  console.log(`\nRe-embedding into ${space.provider}/${space.model} (${space.dimensions}d)\n`);

  let vaultIds: string[];

  if (allVaults) {
    const { data } = await db.from("vaults").select("id, name");
    vaultIds = (data ?? []).map((v) => v.id as string);
  } else if (vaultArg) {
    vaultIds = [vaultArg];
  } else {
    const defaultVault = await getDefaultVaultId();
    if (!defaultVault) {
      throw new Error("No vault found. Upload one first, or pass a vault id.");
    }
    vaultIds = [defaultVault];
  }

  for (const vaultId of vaultIds) {
    const { data: vault } = await db.from("vaults").select("name").eq("id", vaultId).single();
    console.log(`  ${(vault?.name as string) ?? vaultId}`);

    const result = await reembedVault(vaultId, {
      onProgress: (done, total) => {
        const pct = total ? Math.round((done / total) * 100) : 100;
        process.stdout.write(`\r    ${done}/${total} chunks (${pct}%)   `);
      },
    });

    process.stdout.write("\r" + " ".repeat(48) + "\r");
    console.log(`    ${result.chunks} chunks re-embedded in ${result.batches} batches\n`);
  }

  console.log("Done. Retrieval now uses the new embedding space.\n");
}

main().catch((e) => {
  console.error(`\nRe-embed failed: ${errorMessage(e)}\n`);
  process.exit(1);
});
