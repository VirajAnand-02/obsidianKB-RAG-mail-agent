import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { createHash } from "node:crypto";

/**
 * Prompt loading.
 *
 * Prompts live as markdown files (src/prompts, src/evaluator/prompts) rather
 * than string literals so they can be edited, diffed and code-reviewed without
 * touching TypeScript, and so the evaluator can score a specific version of one.
 *
 * Files are read from disk and cached per process. `next.config.ts` force-traces
 * these directories so they exist in the serverless bundle.
 */

export interface Prompt {
  id: string;
  name: string;
  description: string;
  version: string;
  variables: string[];
  /** Body with frontmatter stripped. */
  template: string;
  /** Content hash, recorded on eval runs so a score maps to an exact prompt. */
  hash: string;
}

const PROMPT_DIRS = {
  agent: path.join(process.cwd(), "src", "prompts"),
  evaluator: path.join(process.cwd(), "src", "evaluator", "prompts"),
} as const;

export type PromptScope = keyof typeof PROMPT_DIRS;

const cache = new Map<string, Prompt>();

export async function loadPrompt(name: string, scope: PromptScope = "agent"): Promise<Prompt> {
  const cacheKey = `${scope}:${name}`;
  const cached = cache.get(cacheKey);
  // Hot-reload prompts in development so edits show up without a restart.
  if (cached && process.env.NODE_ENV === "production") return cached;

  const file = path.join(PROMPT_DIRS[scope], `${name}.md`);

  let raw: string;
  try {
    raw = await readFile(/* turbopackIgnore: true */ file, "utf8");
  } catch {
    throw new Error(
      `Prompt "${name}" not found at ${file}. ` +
        `Prompts live in src/prompts (agents) and src/evaluator/prompts (judges).`,
    );
  }

  const { data, content } = matter(raw, { excerpt: false });
  const prompt: Prompt = {
    id: String(data.id ?? name),
    name: String(data.name ?? name),
    description: String(data.description ?? ""),
    version: String(data.version ?? "1"),
    variables: Array.isArray(data.variables) ? data.variables.map(String) : [],
    template: content.trim(),
    hash: createHash("sha256").update(content).digest("hex").slice(0, 16),
  };

  cache.set(cacheKey, prompt);
  return prompt;
}

/**
 * Lists the prompts in a scope.
 *
 * The directory scan is marked `turbopackIgnore` because a dynamic `readdir`
 * otherwise makes the bundler trace the entire project into the serverless
 * output. The prompt files themselves are included explicitly via
 * `outputFileTracingIncludes` in next.config.ts.
 */
export async function listPrompts(scope: PromptScope = "agent"): Promise<Prompt[]> {
  const dir = PROMPT_DIRS[scope];
  const files = await readdir(/* turbopackIgnore: true */ dir).catch(() => [] as string[]);
  return Promise.all(
    files.filter((f) => f.endsWith(".md")).map((f) => loadPrompt(f.replace(/\.md$/, ""), scope)),
  );
}

/**
 * Substitutes {{variable}} placeholders.
 *
 * Unknown placeholders are left intact rather than blanked, so a typo in a
 * variable name is visible in the rendered prompt instead of silently producing
 * an instruction with a hole in it.
 */
export function render(template: string, variables: Record<string, string | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = variables[key];
    return value === undefined ? match : value;
  });
}

/** Loads and renders in one step, warning about declared-but-missing variables. */
export async function renderPrompt(
  name: string,
  variables: Record<string, string | undefined>,
  scope: PromptScope = "agent",
): Promise<{ text: string; prompt: Prompt }> {
  const prompt = await loadPrompt(name, scope);

  const missing = prompt.variables.filter((v) => variables[v] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Prompt "${name}" declares variables that were not supplied: ${missing.join(", ")}.`,
    );
  }

  return { text: render(prompt.template, variables), prompt };
}

export function clearPromptCache() {
  cache.clear();
}
