import { containsCitation, extractCitedIds } from "@/lib/agents/grounding";
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
  // Must accept grouped citations like [C1, C2], not just [C1].
  const cited = sentences.filter((s) => containsCitation(s));
  return cited.length / sentences.length;
}

/** Phrases that signal a refusal or a "not in the notes" response. */
/**
 * Phrases that signal a refusal or a "not in the notes" response.
 *
 * The negation alternatives cover both the contracted and spaced forms of each
 * verb. Matching only `don't` and not `do not` silently scored every correct
 * refusal as a failure — including the system's own not-found reply, which
 * begins "The notes do not contain...".
 */
const NEGATION = String.raw`(?:do(?:es)?\s?n[o']?t|did\s?n[o']?t|could\s?n[o']?t|cannot|can\s?n[o']?t|ca[n]?[o']?t|is\s?n[o']?t|are\s?n[o']?t|was\s?n[o']?t|have\s?n[o']?t|has\s?n[o']?t)`;
// Inflections matter: "cover" alone never matches "not covered".
const LOOKUP_VERB = String.raw`(?:find|found|contain|cover|have|has|include|mention|discuss|reference|say|know|document)(?:s|ed|ing)?`;
// System replies state absence with a wider vocabulary than the lookup verbs:
// "not specified/provided/recorded/listed in the notes". Seen verbatim in the
// IEEE_Proj golden runs, where all four phrasings scored refusalCorrectness=0
// despite being correct refusals (groundedness 1.0 from the judge).
const ABSENCE_VERB = String.raw`(?:specified|provided|recorded|listed|stated|given|documented|mentioned|included|covered|available|present|found)`;

const REFUSAL_PATTERNS = [
  new RegExp(String.raw`\b${NEGATION}\b[^.]{0,60}\b${LOOKUP_VERB}\b`, "i"),
  /\bno(?:thing)?\b[^.]{0,45}\b(?:in|within)\b[^.]{0,30}\b(?:notes?|vault|knowledge base)\b/i,
  new RegExp(
    String.raw`\bnot\b[^.]{0,30}\b${ABSENCE_VERB}\b[^.]{0,30}\b(?:in|within)\b[^.]{0,25}\b(?:notes?|vault|context|documentation)\b`,
    "i",
  ),
  /\bnot (?:covered|available|present|documented|mentioned|included)\b/i,
  /\bI (?:don['’]t|do not) have (?:anything|any information|any notes)\b/i,
  // Direct non-compliance: "I cannot comply with the request ...",
  // "I can't answer that question". Answerable answers never phrase this way,
  // so the false-positive risk is negligible.
  /\bI\s+(?:cannot|can['’]?t|can\s+not|could\s+not|am\s+unable\s+to)\s+(?:comply(?:\s+with)?|help|assist|answer)(?:\s+(?:with\s+)?(?:that|this|the|your))?\s*(?:question|request|instruction|demand)?/i,
];

export function looksLikeRefusal(answer: string): boolean {
  // A refusal asserts absence and therefore cites nothing. Without this guard,
  // honest caveats inside cited answers ("no cost breakdown is provided in the
  // notes", "the library does not explicitly mention X") score as refusals —
  // seen twice in the IEEE_Proj v4 run, where two passing answers flipped to
  // refusalCorrectness=0 after the sender prompt started requiring
  // say-it-is-missing caveats.
  if (extractCitedIds(answer).length > 0) return false;
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
