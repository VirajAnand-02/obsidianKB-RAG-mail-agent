import { appConfig } from "@/lib/app-config";
import { parseNote, isIngestible } from "@/lib/rag/markdown";
import { indexNotes, type IndexStats } from "@/lib/rag/indexer";
import { extractVaultZip, extractVaultFiles, type VaultFile } from "@/lib/vault/zip";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createLogger, errorMessage } from "@/lib/logger";
import type { ParsedNote } from "@/lib/types";

const log = createLogger("vault:ingest");

/**
 * End-to-end vault ingestion: archive -> parsed notes -> indexed chunks.
 * Progress and failures are recorded in `ingest_runs` so the dashboard can show
 * what happened after the request that started it has ended.
 */

export interface IngestResult {
  runId: string;
  vaultId: string;
  stats: IndexStats & {
    filesFound: number;
    attachments: number;
    excluded: number;
  };
  durationMs: number;
}

export function parseVaultFiles(files: VaultFile[]): {
  notes: ParsedNote[];
  unusable: number;
} {
  const options = {
    respectPrivacyFrontmatter: appConfig.ingestion.respectPrivacyFrontmatter,
    privateTags: [...appConfig.ingestion.privateTags],
  };

  const notes: ParsedNote[] = [];
  let unusable = 0;

  for (const file of files) {
    try {
      const note = parseNote(file.path, file.content, options);
      // Empty notes and pure link-dumps embed to noise; leave them out.
      if (!isIngestible(note)) {
        unusable++;
        continue;
      }
      notes.push(note);
    } catch (e) {
      unusable++;
      log.warn("Could not parse note", { path: file.path, error: errorMessage(e) });
    }
  }

  return { notes, unusable };
}

interface IngestOptions {
  vaultId: string;
  trigger?: "manual" | "upload" | "cron" | "api";
  force?: boolean;
  onProgress?: (done: number, total: number, path: string) => void;
}

/** Shared pipeline for both upload shapes. */
async function runIngest(
  extract: () => Promise<{
    files: VaultFile[];
    skipped: { path: string; reason: string }[];
    attachments: number;
  }>,
  options: IngestOptions,
): Promise<IngestResult> {
  const db = supabaseAdmin();
  const startedAt = Date.now();

  const { data: run, error: runError } = await db
    .from("ingest_runs")
    .insert({ vault_id: options.vaultId, trigger: options.trigger ?? "manual", status: "running" })
    .select("id")
    .single();

  if (runError) throw new Error(`Could not start ingest run: ${runError.message}`);
  const runId = run.id as string;

  await db.from("vaults").update({ status: "ingesting", error: null }).eq("id", options.vaultId);

  try {
    const { files, skipped, attachments } = await extract();
    const { notes, unusable } = parseVaultFiles(files);

    log.info("Parsed vault", { files: files.length, notes: notes.length, unusable });

    const stats = await indexNotes(options.vaultId, notes, {
      force: options.force,
      onProgress: options.onProgress,
    });

    const fullStats = {
      ...stats,
      notesSkipped: stats.notesSkipped + unusable,
      filesFound: files.length,
      attachments,
      excluded: skipped.length,
    };

    const durationMs = Date.now() - startedAt;

    await db
      .from("ingest_runs")
      .update({ status: "completed", stats: fullStats, finished_at: new Date().toISOString() })
      .eq("id", runId);

    await db
      .from("vaults")
      .update({
        status: "ready",
        last_ingested_at: new Date().toISOString(),
        stats: {
          notes: fullStats.notesIndexed + fullStats.notesSkipped,
          chunks: fullStats.chunksCreated,
          tokens: fullStats.tokensEmbedded,
          skipped: fullStats.notesSkipped,
          private: fullStats.notesPrivate,
          attachments: fullStats.attachments,
        },
      })
      .eq("id", options.vaultId);

    log.info("Ingest complete", { runId, durationMs, ...fullStats });
    return { runId, vaultId: options.vaultId, stats: fullStats, durationMs };
  } catch (e) {
    const message = errorMessage(e);

    await db
      .from("ingest_runs")
      .update({ status: "failed", error: message, finished_at: new Date().toISOString() })
      .eq("id", runId);
    await db.from("vaults").update({ status: "failed", error: message }).eq("id", options.vaultId);

    log.error("Ingest failed", { runId, error: message });
    throw e;
  }
}

export function ingestZip(
  archive: Uint8Array | ArrayBuffer,
  options: IngestOptions,
): Promise<IngestResult> {
  return runIngest(() => extractVaultZip(archive), options);
}

export function ingestFiles(
  entries: { path: string; content: string; bytes?: number }[],
  options: IngestOptions,
): Promise<IngestResult> {
  return runIngest(() => extractVaultFiles(entries), options);
}

/** Re-runs indexing from the archive stored in Supabase Storage. */
export async function reingestFromStorage(options: IngestOptions): Promise<IngestResult> {
  const db = supabaseAdmin();

  const { data: vault, error } = await db
    .from("vaults")
    .select("archive_path")
    .eq("id", options.vaultId)
    .single();

  if (error) throw new Error(`Vault not found: ${error.message}`);
  if (!vault.archive_path) {
    throw new Error(
      "This vault has no stored archive to re-ingest. Upload the vault again from the Vault page.",
    );
  }

  const { data: blob, error: downloadError } = await db.storage
    .from(appConfig.supabase.storageBucket)
    .download(vault.archive_path as string);

  if (downloadError) throw new Error(`Could not download archive: ${downloadError.message}`);

  const buffer = new Uint8Array(await blob.arrayBuffer());
  return ingestZip(buffer, options);
}
