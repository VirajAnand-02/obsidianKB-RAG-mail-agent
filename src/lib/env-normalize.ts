/**
 * Removes empty-string environment variables.
 *
 * A `.env` written from `.env.example` is full of `KEY=` lines for optional
 * settings, and dotenv turns those into `""` rather than leaving them unset.
 * Several AI SDK providers build a default instance at module scope from
 * `process.env` and reject an empty string — `@ai-sdk/openai` throws
 * "baseURL must be a non-empty string" on import if `OPENAI_BASE_URL=` is
 * present, which takes down the whole build.
 *
 * Deleting the blanks makes `KEY=` mean "not configured", which is what anyone
 * writing that line intends.
 *
 * This must be imported *before* any provider package. ES module evaluation
 * follows import order within a file, so placing it as the first import of
 * `registry.ts` and `embeddings.ts` is sufficient.
 */

const OPTIONAL_URL_VARS = [
  "OPENAI_BASE_URL",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OLLAMA_BASE_URL",
  "AZURE_RESOURCE_NAME",
];

function normalise() {
  if (typeof process === "undefined" || !process.env) return;

  for (const key of OPTIONAL_URL_VARS) {
    if (process.env[key] !== undefined && process.env[key]!.trim() === "") {
      delete process.env[key];
    }
  }

  // Blank API keys are equally meaningless and confuse "is this configured?"
  // checks that only test for presence.
  for (const [key, value] of Object.entries(process.env)) {
    if ((key.endsWith("_API_KEY") || key.endsWith("_KEY")) && value !== undefined && value.trim() === "") {
      delete process.env[key];
    }
  }
}

normalise();

export {};
