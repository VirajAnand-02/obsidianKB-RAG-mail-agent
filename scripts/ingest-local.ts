import "dotenv/config";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { env } from "@/lib/env";
import { appConfig } from "@/lib/app-config";
import { ingestFiles } from "@/lib/vault/ingest";
import { isExcluded } from "@/lib/vault/zip";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getWorkspaceId, setDefaultVault } from "@/lib/workspace";
import { errorMessage } from "@/lib/logger";

/**
 * Indexes an Obsidian vault straight from a local directory.
 *
 *   npm run vault:ingest -- "C:/Users/me/Documents/MyVault"
 *   npm run vault:ingest -- ./vault --name "Work notes" --vault <existing-id>
 *
 * Faster than the browser upload for large vaults during development, since
 * nothing is zipped or sent over the network.
 */

async function collectMarkdown(root: string): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, "/");

      if (isExcluded(relative, [...appConfig.ingestion.excludeGlobs])) continue;
      // Obsidian's own config and trash directories are never notes.
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        await walk(absolute);
        continue;
      }

      if (!/\.(md|markdown|mdx)$/i.test(entry.name)) continue;
      files.push({ path: relative, content: await readFile(absolute, "utf8") });
    }
  }

  await walk(root);
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const target = positional[0];

  if (!target) {
    console.error(
      "\nUsage: npm run vault:ingest -- <path-to-vault> [--name <name>] [--vault <id>]\n",
    );
    process.exit(2);
  }

  const nameIndex = args.indexOf("--name");
  const vaultIndex = args.indexOf("--vault");
  const name = nameIndex !== -1 ? args[nameIndex + 1] : path.basename(path.resolve(target));
  const existingVaultId = vaultIndex !== -1 ? args[vaultIndex + 1] : undefined;

  const root = path.resolve(target);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`${root} is not a directory.`);
  }

  console.log(`\nIndexing ${root}\n`);

  const files = await collectMarkdown(root);
  console.log(`  found ${files.length} markdown files`);

  if (files.length === 0) {
    throw new Error("No markdown files found. Is this the vault root?");
  }

  const db = supabaseAdmin();
  let vaultId = existingVaultId;

  if (!vaultId) {
    const workspaceId = await getWorkspaceId();
    const { data, error } = await db
      .from("vaults")
      .insert({
        workspace_id: workspaceId,
        name,
        description: `Ingested from ${root}`,
        source: "folder",
        status: "pending",
      })
      .select("id")
      .single();

    if (error) throw new Error(`Could not create the vault: ${error.message}`);
    vaultId = data.id as string;
  }

  const result = await ingestFiles(files, {
    vaultId,
    trigger: "manual",
    onProgress: (done, total, notePath) => {
      const pct = Math.round((done / total) * 100);
      process.stdout.write(`\r  ${done}/${total} (${pct}%) ${notePath.slice(0, 44).padEnd(44)}`);
    },
  });

  process.stdout.write("\r" + " ".repeat(76) + "\r");

  if (!existingVaultId) await setDefaultVault(vaultId);

  console.log(`  ${result.stats.notesIndexed} indexed`);
  console.log(`  ${result.stats.notesSkipped} skipped (unchanged or empty)`);
  console.log(`  ${result.stats.notesPrivate} private (excluded from retrieval)`);
  console.log(`  ${result.stats.chunksCreated} chunks, ${result.stats.tokensEmbedded} tokens`);
  console.log(`  ${Math.round(result.durationMs / 100) / 10}s\n`);

  if (result.stats.errors.length > 0) {
    console.log(`  ${result.stats.errors.length} notes failed:`);
    for (const e of result.stats.errors.slice(0, 10)) {
      console.log(`    ${e.path}: ${e.error}`);
    }
    console.log();
  }

  console.log(`  vault id: ${vaultId}\n`);
}

main().catch((e) => {
  console.error(`\nIngest failed: ${errorMessage(e)}\n`);
  process.exit(1);
});
