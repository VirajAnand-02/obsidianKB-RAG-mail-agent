import { extractCitedIds } from "@/lib/agents/grounding";
import type { RetrievedChunk } from "@/lib/types";

/**
 * Deterministic generation metrics — the checks that do not need a judge.
 * Cheap, exactly reproducible, and they catch the failure modes that matter
 * most, so they run before any model is called.
 */

/**
 * Citation validity: every `[Cn]` in the answer points at a chunk that was
 * actually retrieved.
 *
 * A fabricated citation is the most dangerous failure this system has, because
 * it looks like evidence. Scored 0 or 1 rather than partially — one invented
 * citation makes the whole answer untrustworthy.
 */
export function citationValidity(
  answer: string,
  chunks: RetrievedChunk[],
): { score: number; cited: string[]; invalid: string[]; uncited: boolean } {
  const available = new Set(chunks.map((c) => c.citationId).filter(Boolean) as string[]);
  const cited = extractCitedIds(answer);
  const invalid = cited.filter((id) => !available.has(id));

  return {
    score: invalid.length === 0 ? 1 : 0,
    cited,
    invalid,
    uncited: cited.length === 0,
  };
}

/**
 * Fraction of sentences carrying a citation.
 *
 * Not scored directly — a well-written answer legitimately has uncited
 * connective sentences — but a sharp drop after a prompt change usually means
 * the model has quietly stopped citing.
 */
export function citationDensity(answer: string): number {
  const sentences = answer
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);

  if (sentences.length === 0) return 0;
  const cited = sentences.filter((s) => /\[C\d+\]/.test(s));
  return cited.length / sentences.length;
}

/** Phrases that signal a refusal or a "not in the notes" response. */
const REFUSAL_PATTERNS = [
  /\b(?:do(?:es)?n[o']t|did not|didn[o']t|could not|couldn[o']t|cannot|can[o']t)\b[^.]{0,40}\b(?:find|contain|cover|have|include|mention)\b/i,
  /\bno(?:thing)?\b[^.]{0,30}\b(?:in|within)\b[^.]{0,20}\b(?:notes?|vault|knowledge base)\b/i,
  /\bnot (?:covered|available|present|documented)\b/i,
  /\bI (?:don't|do not) have (?:anything|any information)\b/i,
];

export function looksLikeRefusal(answer: string): boolean {
  return REFUSAL_PATTERNS.some((p) => p.test(answer));
}

/**
 * Scores refusal behaviour on cases marked `shouldRefuse`.
 *
 * Worth measuring on its own: a system that never refuses scores well on
 * answerable questions while hallucinating confidently on everything else, and
 * only this metric distinguishes the two.
 */
export function refusalCorrectness(answer: string, shouldRefuse: boolean): number {
  const refused = looksLikeRefusal(answer);
  if (shouldRefuse) return refused ? 1 : 0;
  // Refusing an answerable question is a miss, though a safe one.
  return refused ? 0 : 1;
}

export function generationMetrics(
  answer: string,
  chunks: RetrievedChunk[],
  shouldRefuse = false,
) {
  const citations = citationValidity(answer, chunks);
  return {
    citationValidity: citations.score,
    citationDensity: citationDensity(answer),
    invalidCitations: citations.invalid,
    refusalCorrectness: refusalCorrectness(answer, shouldRefuse),
    refused: looksLikeRefusal(answer),
    answerLength: answer.length,
  };
}
