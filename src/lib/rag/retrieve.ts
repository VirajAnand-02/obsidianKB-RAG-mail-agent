import { generateText, rerank } from "ai";
import { createCohere } from "@ai-sdk/cohere";

import { getRuntimeConfig } from "@/lib/config";
import { getLanguageModel, resolveApiKey } from "@/lib/ai/registry";
import { embedTexts, toVectorLiteral } from "@/lib/ai/embeddings";
import { renderPrompt } from "@/lib/prompts";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { countTokens } from "@/lib/rag/tokenize";
import { createLogger, errorMessage } from "@/lib/logger";
import type { RetrievalOptions, RetrievalResult, RetrievedChunk } from "@/lib/types";

const log = createLogger("rag:retrieve");

/**
 * The retrieval pipeline.
 *
 *   question
 *     -> query expansion (3 variants: keyword / restated / hypothetical answer)
 *     -> embed all variants
 *     -> hybrid search per variant (pgvector + full-text, fused with RRF in SQL)
 *     -> fuse across variants
 *     -> neighbour-window expansion
 *     -> optional cross-encoder rerank
 *     -> pack into a token-budgeted context block with citation ids
 *
 * Each stage is individually switchable from Settings, which matters because
 * the evaluator scores configurations against each other — being able to turn
 * off expansion and re-run the golden set is how you find out if it helps.
 */

// ---------------------------------------------------------------------------
// Query expansion
// ---------------------------------------------------------------------------

/**
 * Rewrites the question into retrieval variants.
 * Failures degrade to the original question rather than aborting the answer.
 */
export async function expandQuery(question: string, count: number): Promise<string[]> {
  if (count <= 1) return [question];

  try {
    const { text: promptText } = await renderPrompt("queryRewrite", {
      question,
      count: String(count),
    });
    const { model } = await getLanguageModel();

    const { text } = await generateText({
      model,
      prompt: promptText,
      temperature: 0.3,
      maxOutputTokens: 400,
    });

    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [question];

    const variants = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(variants)) return [question];

    const cleaned = variants
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim())
      .slice(0, count);

    // The original question always stays in the set; variants only add coverage.
    return [...new Set([question, ...cleaned])];
  } catch (e) {
    log.warn("Query expansion failed, using the original question", { error: errorMessage(e) });
    return [question];
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

interface RawHit {
  chunk_id: string;
  note_id: string;
  path: string;
  title: string;
  heading_path: string[];
  content: string;
  ordinal: number;
  token_count: number;
  tags: string[];
  note_updated_at: string | null;
  similarity: number | null;
  fts_score: number | null;
  score: number;
}

function toRetrieved(hit: RawHit): RetrievedChunk {
  return {
    chunkId: hit.chunk_id,
    noteId: hit.note_id,
    path: hit.path,
    title: hit.title,
    headingPath: hit.heading_path ?? [],
    content: hit.content,
    ordinal: hit.ordinal,
    tokenCount: hit.token_count,
    tags: hit.tags ?? [],
    noteUpdatedAt: hit.note_updated_at,
    similarity: hit.similarity,
    ftsScore: hit.fts_score,
    score: hit.score,
  };
}

/**
 * Fuses per-variant result lists with Reciprocal Rank Fusion.
 *
 * A chunk that ranks moderately for several phrasings of the question is a
 * better bet than one that ranks first for a single phrasing, and RRF captures
 * that without needing the variants' scores to be comparable.
 */
function fuseAcrossQueries(lists: RetrievedChunk[][], rrfK: number): RetrievedChunk[] {
  const byId = new Map<string, RetrievedChunk>();
  const fused = new Map<string, number>();

  for (const list of lists) {
    list.forEach((chunk, index) => {
      const previous = byId.get(chunk.chunkId);
      if (!previous || (chunk.similarity ?? 0) > (previous.similarity ?? 0)) {
        byId.set(chunk.chunkId, chunk);
      }
      fused.set(chunk.chunkId, (fused.get(chunk.chunkId) ?? 0) + 1 / (rrfK + index + 1));
    });
  }

  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...byId.get(id)!, score }));
}

// ---------------------------------------------------------------------------
// Reranking
// ---------------------------------------------------------------------------

async function rerankWithJina(
  query: string,
  chunks: RetrievedChunk[],
  model: string,
  topN: number,
): Promise<RetrievedChunk[]> {
  const apiKey = await resolveApiKey("jina");
  if (!apiKey) throw new Error("JINA_API_KEY is required for the Jina reranker.");

  const res = await fetch("https://api.jina.ai/v1/rerank", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, query, top_n: topN, documents: chunks.map((c) => c.content) }),
  });
  if (!res.ok) throw new Error(`Jina rerank failed (${res.status}): ${await res.text()}`);

  const json = (await res.json()) as { results: { index: number; relevance_score: number }[] };
  return json.results.map((r) => ({
    ...chunks[r.index],
    rerankScore: r.relevance_score,
    score: r.relevance_score,
  }));
}

/**
 * Cross-encoder rerank. Optional, and off by default: it is the single biggest
 * precision win available, but it adds a paid API call and latency to every
 * question, so it should be a deliberate choice rather than a default.
 */
async function applyRerank(
  query: string,
  chunks: RetrievedChunk[],
  provider: "cohere" | "jina",
  model: string,
  topN: number,
): Promise<RetrievedChunk[]> {
  if (chunks.length === 0) return chunks;

  if (provider === "jina") return rerankWithJina(query, chunks, model, topN);

  const apiKey = await resolveApiKey("cohere");
  if (!apiKey) throw new Error("COHERE_API_KEY is required for the Cohere reranker.");

  const { ranking } = await rerank({
    model: createCohere({ apiKey }).rerankingModel(model),
    query,
    documents: chunks.map((c) => c.content),
    topN,
  });

  return ranking.map((r) => ({
    ...chunks[r.originalIndex],
    rerankScore: r.score,
    score: r.score,
  }));
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

/**
 * Renders retrieved chunks into the block the answering prompt sees, assigning
 * the [C1]..[Cn] ids that citations and the grounding check both key off.
 *
 * Chunks are added in rank order until the token budget is spent, so the least
 * relevant material is what gets dropped.
 */
export function buildContextBlock(
  chunks: RetrievedChunk[],
  tokenBudget: number,
): { block: string; used: RetrievedChunk[]; tokens: number } {
  const parts: string[] = [];
  const used: RetrievedChunk[] = [];
  let tokens = 0;

  for (const chunk of chunks) {
    const citationId = `C${used.length + 1}`;
    const breadcrumb = chunk.headingPath.length ? chunk.headingPath.join(" > ") : chunk.title;
    const updated = chunk.noteUpdatedAt ? ` | updated: ${chunk.noteUpdatedAt.slice(0, 10)}` : "";

    const rendered =
      `[${citationId}] ${breadcrumb}\n` +
      `source: ${chunk.path}${updated}\n` +
      `---\n${chunk.content}\n`;

    const cost = countTokens(rendered);
    if (tokens + cost > tokenBudget && used.length > 0) break;

    parts.push(rendered);
    used.push({ ...chunk, citationId });
    tokens += cost;
  }

  return { block: parts.join("\n"), used, tokens };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function retrieve(options: RetrievalOptions): Promise<RetrievalResult> {
  const config = await getRuntimeConfig();
  const startedAt = Date.now();

  const topK = options.topK ?? config.retrieval.topK;
  const candidateK = options.candidateK ?? config.retrieval.candidateK;
  const minScore = options.minScore ?? config.retrieval.minScore;
  const hybrid = options.hybrid ?? config.retrieval.hybrid;
  const neighborWindow = options.neighborWindow ?? config.retrieval.neighborWindow;
  const useExpansion = options.queryExpansion ?? config.retrieval.queryExpansion;

  // ---- 1. expand -----------------------------------------------------------
  const queries = useExpansion
    ? await expandQuery(options.query, config.retrieval.queryVariants)
    : [options.query];

  // ---- 2. embed ------------------------------------------------------------
  const embedStart = Date.now();
  const vectors = await embedTexts(queries, "query");
  const embedMs = Date.now() - embedStart;

  // ---- 3. search -----------------------------------------------------------
  const searchStart = Date.now();
  const db = supabaseAdmin();

  const lists = await Promise.all(
    queries.map(async (query, i) => {
      const { data, error } = await db.rpc("hybrid_search", {
        p_vault_id: options.vaultId,
        p_query_embedding: toVectorLiteral(vectors[i]),
        p_query_text: hybrid ? query : null,
        p_candidate_k: candidateK,
        p_match_count: candidateK,
        p_rrf_k: config.retrieval.rrfK,
        p_min_score: minScore,
        p_space_id: null,
        p_ef_search: config.retrieval.efSearch,
        p_include_private: options.includePrivate ?? false,
      });

      if (error) {
        throw new Error(`Retrieval failed: ${error.message}. Have you run \`npm run db:migrate\`?`);
      }
      return ((data ?? []) as RawHit[]).map(toRetrieved);
    }),
  );

  let chunks = fuseAcrossQueries(lists, config.retrieval.rrfK);
  const searchMs = Date.now() - searchStart;

  // ---- 4. rerank -----------------------------------------------------------
  // Reranking happens before neighbour expansion: the cross-encoder should score
  // the passages that actually matched, not the padding around them.
  let rerankMs = 0;
  if (config.retrieval.reranker !== "none" && chunks.length > 1) {
    const rerankStart = Date.now();
    try {
      chunks = await applyRerank(
        options.query,
        chunks.slice(0, candidateK),
        config.retrieval.reranker,
        config.retrieval.rerankerModel,
        topK,
      );
    } catch (e) {
      log.warn("Rerank failed, falling back to fused order", { error: errorMessage(e) });
    }
    rerankMs = Date.now() - rerankStart;
  }

  chunks = chunks.slice(0, topK);

  // ---- 5. neighbour expansion ---------------------------------------------
  if (neighborWindow > 0 && chunks.length > 0) {
    chunks = await expandWithNeighbors(chunks, neighborWindow);
  }

  // ---- 6. pack -------------------------------------------------------------
  const { block, used, tokens } = buildContextBlock(chunks, config.retrieval.contextTokenBudget);

  return {
    chunks: used,
    queries,
    contextBlock: block,
    contextTokens: tokens,
    timings: { embedMs, searchMs, rerankMs, totalMs: Date.now() - startedAt },
  };
}

/**
 * Pulls the chunks adjacent to each hit and splices them in beside their seed,
 * so the model reads a note in reading order rather than as disconnected
 * fragments. Neighbours inherit a slightly lower score so they never outrank
 * a real match during packing.
 */
async function expandWithNeighbors(
  chunks: RetrievedChunk[],
  window: number,
): Promise<RetrievedChunk[]> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("chunk_neighbors", {
    p_chunk_ids: chunks.map((c) => c.chunkId),
    p_window: window,
  });

  if (error) {
    log.warn("Neighbour expansion failed, continuing without it", { error: error.message });
    return chunks;
  }

  const seeds = new Map(chunks.map((c) => [c.chunkId, c]));
  const byNote = new Map<string, RetrievedChunk[]>();

  for (const row of (data ?? []) as {
    chunk_id: string;
    note_id: string;
    path: string;
    title: string;
    heading_path: string[];
    content: string;
    ordinal: number;
    token_count: number;
    is_seed: boolean;
  }[]) {
    const seed = seeds.get(row.chunk_id);
    const chunk: RetrievedChunk = seed
      ? { ...seed, isNeighbor: false }
      : {
          chunkId: row.chunk_id,
          noteId: row.note_id,
          path: row.path,
          title: row.title,
          headingPath: row.heading_path ?? [],
          content: row.content,
          ordinal: row.ordinal,
          tokenCount: row.token_count,
          tags: [],
          noteUpdatedAt: null,
          similarity: null,
          ftsScore: null,
          // Sits just below the weakest real hit so packing prefers matches.
          score: 0,
          isNeighbor: true,
        };

    const list = byNote.get(row.note_id) ?? [];
    list.push(chunk);
    byNote.set(row.note_id, list);
  }

  // Order notes by their best seed, and chunks within a note by reading order.
  const noteRank = new Map<string, number>();
  chunks.forEach((c, i) => {
    if (!noteRank.has(c.noteId)) noteRank.set(c.noteId, i);
  });

  return [...byNote.entries()]
    .sort((a, b) => (noteRank.get(a[0]) ?? 999) - (noteRank.get(b[0]) ?? 999))
    .flatMap(([, list]) => list.sort((a, b) => a.ordinal - b.ordinal));
}
