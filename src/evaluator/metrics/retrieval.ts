import type { RetrievedChunk } from "@/lib/types";

/**
 * Deterministic retrieval metrics.
 *
 * These need no model and no API budget, so they run on every case. When a
 * score regresses, they answer the first question worth asking: did retrieval
 * fail, or did generation fail? An answer can only be as good as what was
 * retrieved, and these isolate that half.
 */

/** Note paths are compared case-insensitively, with or without the .md suffix. */
function normalisePath(path: string): string {
  return path.toLowerCase().replace(/\.md$/, "").replace(/^\/+/, "");
}

/** True when an expected source matches a retrieved path, by suffix. */
function matches(retrieved: string, expected: string): boolean {
  const r = normalisePath(retrieved);
  const e = normalisePath(expected);
  // Golden sets usually record a note title or a partial path, not the full one.
  return r === e || r.endsWith(`/${e}`) || r.includes(e);
}

/**
 * Fraction of expected source notes that appear anywhere in the retrieved set.
 * The ceiling on answer quality: what was never retrieved cannot be cited.
 */
export function contextRecall(chunks: RetrievedChunk[], expectedSources: string[]): number | null {
  if (expectedSources.length === 0) return null;

  const paths = chunks.map((c) => c.path);
  const found = expectedSources.filter((expected) => paths.some((p) => matches(p, expected)));
  return found.length / expectedSources.length;
}

/**
 * Fraction of retrieved chunks that come from an expected note.
 * Low precision means the context window is being spent on noise.
 */
export function contextPrecision(chunks: RetrievedChunk[], expectedSources: string[]): number | null {
  if (expectedSources.length === 0 || chunks.length === 0) return null;

  // Neighbour chunks were pulled in deliberately, so they are not counted as
  // retrieval misses.
  const scored = chunks.filter((c) => !c.isNeighbor);
  if (scored.length === 0) return null;

  const relevant = scored.filter((c) => expectedSources.some((e) => matches(c.path, e)));
  return relevant.length / scored.length;
}

/**
 * Reciprocal rank of the first expected note.
 * Sensitive to ordering in a way recall is not — models weight early context
 * more heavily, so a correct chunk at rank 8 is worth less than at rank 1.
 */
export function reciprocalRank(chunks: RetrievedChunk[], expectedSources: string[]): number | null {
  if (expectedSources.length === 0) return null;

  const index = chunks.findIndex((c) => expectedSources.some((e) => matches(c.path, e)));
  return index === -1 ? 0 : 1 / (index + 1);
}

/** Normalised discounted cumulative gain over graded relevance judgements. */
export function ndcg(ratings: number[], idealRatings?: number[]): number | null {
  if (ratings.length === 0) return null;

  const dcg = ratings.reduce((sum, rating, i) => sum + rating / Math.log2(i + 2), 0);
  const ideal = (idealRatings ?? [...ratings].sort((a, b) => b - a)).reduce(
    (sum, rating, i) => sum + rating / Math.log2(i + 2),
    0,
  );

  return ideal === 0 ? 0 : dcg / ideal;
}

/** Every deterministic retrieval metric for one case. */
export function retrievalMetrics(chunks: RetrievedChunk[], expectedSources: string[] = []) {
  return {
    contextRecall: contextRecall(chunks, expectedSources),
    contextPrecision: contextPrecision(chunks, expectedSources),
    reciprocalRank: reciprocalRank(chunks, expectedSources),
    retrievedCount: chunks.length,
    neighborCount: chunks.filter((c) => c.isNeighbor).length,
    uniqueNotes: new Set(chunks.map((c) => c.path)).size,
  };
}
