import { z } from "zod";

/**
 * Lenient string fields for model-generated JSON.
 *
 * Prompts routinely describe a field as "... or null" — that is the clearest
 * way to say "nothing to report here". A plain `z.string()` rejects it, and
 * because `generateObject` throws on a schema mismatch, one such field takes
 * down the entire call.
 *
 * That failure is unusually expensive here. Both agents that parse model JSON
 * fail closed: a triage error is treated as "needs a human", and a grounding
 * error routes to review. So a single missing `.nullish()` does not surface as
 * a parse error — it silently stops the system sending anything, and looks
 * like the gate being cautious. It has now caused that twice.
 *
 * The rule these encode: be permissive about the *shape* a model returns, and
 * strict about what the values mean.
 */

/** A string that may arrive as null or absent; collapses to `fallback`. */
export const looseString = (fallback = "") =>
  z
    .string()
    .nullish()
    .transform((v) => v ?? fallback);

/**
 * A string where null is meaningful ("no answer to give") rather than empty.
 * Keeps the null instead of flattening it to "".
 */
export const nullableString = () =>
  z
    .string()
    .nullish()
    .transform((v) => v ?? null);

/** A string that may arrive as null; normalised to `undefined` for optional fields. */
export const optionalString = () =>
  z
    .string()
    .nullish()
    .transform((v) => v ?? undefined);
