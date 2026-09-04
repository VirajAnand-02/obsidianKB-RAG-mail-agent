import { getEncoding, type Tiktoken } from "js-tiktoken";

/**
 * Token counting for chunk sizing and context budgeting.
 *
 * cl100k_base is not the exact tokenizer for every provider we support, but
 * chunk boundaries only need to be consistent and approximately right — being
 * within a few percent across models is enough, and it avoids shipping a
 * different tokenizer per provider.
 */

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken | null {
  if (encoder) return encoder;
  try {
    encoder = getEncoding("cl100k_base");
    return encoder;
  } catch {
    // Falls back to the heuristic below rather than failing ingestion.
    return null;
  }
}

/** Rough token estimate used when the real tokenizer is unavailable. */
function estimate(text: string): number {
  return Math.ceil(text.length / 3.8);
}

export function countTokens(text: string): number {
  if (!text) return 0;
  const enc = getEncoder();
  if (!enc) return estimate(text);
  try {
    return enc.encode(text).length;
  } catch {
    return estimate(text);
  }
}

/** Truncates to at most `maxTokens`, cutting on a token boundary. */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  const enc = getEncoder();
  if (!enc) {
    const approxChars = Math.floor(maxTokens * 3.8);
    return text.length <= approxChars ? text : text.slice(0, approxChars);
  }
  try {
    const tokens = enc.encode(text);
    if (tokens.length <= maxTokens) return text;
    return enc.decode(tokens.slice(0, maxTokens));
  } catch {
    return text.slice(0, Math.floor(maxTokens * 3.8));
  }
}

export function fitsInBudget(text: string, budget: number): boolean {
  return countTokens(text) <= budget;
}
