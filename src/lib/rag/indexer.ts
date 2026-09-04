import pLimit from "p-limit";

import { getRuntimeConfig } from "@/lib/config";
import { assertSupportedDimension, embedTexts, lookupEmbeddingModel } from "@/lib/ai/embeddings";
import { chunkNote } from "@/lib/rag/chunk";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createLogger, errorMessage } from "@/lib/logger";
import type { EmbeddingSpace, ParsedNote } from "@/lib/types";

const log = createLogger("rag:indexer");

/**
 * Indexing: parsed notes -> rows in `notes`, `chunks`, and the embedding table
 * matching the active space's dimension.
 */

/** Physical table for a dimension, mirroring `embedding_table_for` in SQL. */
export function embeddingTableFor(dimensions: number): string {
  assertSupportedDimension(dimensions);
  return `embeddings_${dimensions}`;
}

/**
 * Returns the active embedding space, creating it from the current config if
 * the configured model has never been used before.
 *
 * This is what makes switching embedding provider in the dashboard safe: the new
 * model gets its own space and its own table, and the old vectors stay intact
 * until they are explicitly dropped.
 */
export async function ensureEmbeddingSpace(): Promise<EmbeddingSpace> {
  const config = await getRuntimeConfig();
  const db = supabaseAdmin();
  const { provider, model, dimensions } = config.embedding;

  assertSupportedDimension(dimensions);

  const { data: existing } = await db
    .from("embedding_spaces")
    .select("*")
    .eq("provider", provider)
    .eq("model", model)
    .eq("dimensions", dimensions)
    .maybeSingle();

  if (existing) {
    if (!existing.is_active) {
      const { error } = await db.rpc("activate_embedding_space", { p_space_id: existing.id });
      if (error) throw new Error(`Could not activate embedding space: ${error.message}`);
    }
    return existing as EmbeddingSpace;
  }

  const known = lookupEmbeddingModel(provider, model);
  const { data: created, error } = await db
    .from("embedding_spaces")
    .insert({
      provider,
      model,
      dimensions,
      doc_prefix: config.embedding.docPrefix || known?.docPrefix || "",
      query_prefix: config.embedding.queryPrefix || known?.queryPrefix || "",
      is_active: false,
      notes: known?.note ?? null,
    })
    .select()
    .single();

  if (error) throw new Error(`Could not create embedding space: ${error.message}`);

  const { error: activateError } = await db.rpc("activate_embedding_space", {
    p_space_id: created.id,
  });
  if (activateError) throw new Error(`Could not activate embedding space: ${activateError.message}`);

  log.info("Created embedding space", { provider, model, dimensions });
  return { ...(created as EmbeddingSpace), is_active: true };
}

export interface IndexStats {
  notesTotal: number;
  notesIndexed: number;
  notesSkipped: number;
  notesPrivate: number;
  notesFailed: number;
  chunksCreated: number;
  tokensEmbedded: number;
  errors: { path: string; error: string }[];
}

export interface IndexOptions {
  /** Re-embed even when the content hash is unchanged. */
  force?: boolean;
  onProgress?: (done: number, total: number, path: string) => void;
}

/**
 * Indexes a batch of parsed notes into a vault.
 *
 * Unchanged notes are skipped by content hash, which is what makes re-uploading
 * a vault cheap: a 2,000-note vault where 5 notes changed costs 5 notes' worth
 * of embedding calls, not 2,000.
 */
export async function indexNotes(
  vaultId: string,
  notes: ParsedNote[],
  options: IndexOptions = {},
): Promise<IndexStats> {
  const config = await getRuntimeConfig();
  const db = supabaseAdmin();
  const space = await ensureEmbeddingSpace();
  const table = embeddingTableFor(space.dimensions);

  const stats: IndexStats = {
    notesTotal: notes.length,
    notesIndexed: 0,
    notesSkipped: 0,
    notesPrivate: 0,
    notesFailed: 0,
    chunksCreated: 0,
    tokensEmbedded: 0,
    errors: [],
  };

  // Existing hashes, so unchanged notes can be skipped without a round trip each.
  const { data: existingRows } = await db
    .from("notes")
    .select("id, path, content_hash")
    .eq("vault_id", vaultId);

  const existing = new Map(
    (existingRows ?? []).map((r) => [r.path as string, { id: r.id as string, hash: r.content_hash as string }]),
  );

  const limit = pLimit(Math.max(1, config.embedding.concurrency));
  let done = 0;

  await Promise.all(
    notes.map((note) =>
      limit(async () => {
        try {
          const prior = existing.get(note.path);

          if (prior && prior.hash === note.contentHash && !options.force) {
            stats.notesSkipped++;
            return;
          }

          // Upsert the note row first; chunks and vectors hang off its id.
          const { data: noteRow, error: noteError } = await db
            .from("notes")
            .upsert(
              {
                vault_id: vaultId,
                path: note.path,
                title: note.title,
                frontmatter: note.frontmatter,
                tags: note.tags,
                links: note.links,
                aliases: note.aliases,
                content_hash: note.contentHash,
                word_count: note.wordCount,
                is_private: note.isPrivate,
                note_created_at: note.createdAt ?? null,
                note_updated_at: note.updatedAt ?? null,
                deleted_at: null,
              },
              { onConflict: "vault_id,path" },
            )
            .select("id")
            .single();

          if (noteError) throw new Error(noteError.message);
          const noteId = noteRow.id as string;

          if (note.isPrivate) {
            // Private notes are recorded (so the UI can show what was excluded)
            // but never chunked or embedded.
            await db.from("chunks").delete().eq("note_id", noteId);
            stats.notesPrivate++;
            return;
          }

          const chunks = chunkNote(note.title, note.body, config.chunking);
          if (chunks.length === 0) {
            stats.notesSkipped++;
            return;
          }

          // Replace chunks wholesale. Cascade removes the old vectors, which is
          // simpler and safer than diffing chunk boundaries after an edit.
          await db.from("chunks").delete().eq("note_id", noteId);

          const { data: chunkRows, error: chunkError } = await db
            .from("chunks")
            .insert(
              chunks.map((c) => ({
                note_id: noteId,
                vault_id: vaultId,
                ordinal: c.ordinal,
                heading_path: c.headingPath,
                content: c.content,
                token_count: c.tokenCount,
                char_start: c.charStart,
                char_end: c.charEnd,
                content_hash: c.contentHash,
              })),
            )
            .select("id, ordinal");

          if (chunkError) throw new Error(chunkError.message);

          const embeddings = await embedTexts(
            chunks.map((c) => c.content),
            "document",
          );

          const ordered = [...(chunkRows ?? [])].sort(
            (a, b) => (a.ordinal as number) - (b.ordinal as number),
          );

          const { error: embedError } = await db.from(table).upsert(
            ordered.map((row, i) => ({
              chunk_id: row.id,
              space_id: space.id,
              vault_id: vaultId,
              embedding: JSON.stringify(embeddings[i]),
            })),
            { onConflict: "chunk_id,space_id" },
          );

          if (embedError) throw new Error(embedError.message);

          stats.notesIndexed++;
          stats.chunksCreated += chunks.length;
          stats.tokensEmbedded += chunks.reduce((sum, c) => sum + c.tokenCount, 0);
        } catch (e) {
          // One bad note should not abort a 2,000-note ingest.
          stats.notesFailed++;
          stats.errors.push({ path: note.path, error: errorMessage(e) });
          log.warn("Failed to index note", { path: note.path, error: errorMessage(e) });
        } finally {
          done++;
          options.onProgress?.(done, notes.length, note.path);
        }
      }),
    ),
  );

  // Notes present in the vault before but absent from this upload are soft
  // deleted, so a deleted note stops being quoted in emails.
  const uploadedPaths = new Set(notes.map((n) => n.path));
  const removed = [...existing.keys()].filter((p) => !uploadedPaths.has(p));

  if (removed.length > 0) {
    await db
      .from("notes")
      .update({ deleted_at: new Date().toISOString() })
      .eq("vault_id", vaultId)
      .in("path", removed);
    log.info("Soft-deleted notes missing from upload", { count: removed.length });
  }

  return stats;
}

/**
 * Re-embeds every chunk in a vault against the active space.
 * Used after switching embedding model, where chunk text is unchanged but the
 * vectors need to be regenerated in a different space (and table).
 */
export async function reembedVault(
  vaultId: string,
  options: { batchSize?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ chunks: number; batches: number }> {
  const db = supabaseAdmin();
  const space = await ensureEmbeddingSpace();
  const table = embeddingTableFor(space.dimensions);
  const batchSize = options.batchSize ?? 128;

  const { count } = await db
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .eq("vault_id", vaultId);

  const total = count ?? 0;
  let done = 0;
  let batches = 0;

  for (let offset = 0; offset < total; offset += batchSize) {
    const { data: rows, error } = await db
      .from("chunks")
      .select("id, content")
      .eq("vault_id", vaultId)
      .order("id")
      .range(offset, offset + batchSize - 1);

    if (error) throw new Error(`Could not read chunks: ${error.message}`);
    if (!rows || rows.length === 0) break;

    const embeddings = await embedTexts(
      rows.map((r) => r.content as string),
      "document",
    );

    const { error: upsertError } = await db.from(table).upsert(
      rows.map((row, i) => ({
        chunk_id: row.id,
        space_id: space.id,
        vault_id: vaultId,
        embedding: JSON.stringify(embeddings[i]),
      })),
      { onConflict: "chunk_id,space_id" },
    );

    if (upsertError) throw new Error(`Could not write embeddings: ${upsertError.message}`);

    done += rows.length;
    batches++;
    options.onProgress?.(done, total);
  }

  return { chunks: done, batches };
}
