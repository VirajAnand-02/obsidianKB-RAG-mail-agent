import { createHash } from "node:crypto";
import matter from "gray-matter";
import type { ParsedNote } from "@/lib/types";

/**
 * Obsidian-flavoured markdown parsing.
 *
 * Beyond frontmatter this handles the vault-specific syntax that plain markdown
 * parsers drop: [[wikilinks]] (with |aliases and #headings), inline #tags,
 * ![[embeds]], block references (^block-id), and callouts.
 */

const WIKILINK = /!?\[\[([^\]]+)\]\]/g;
const INLINE_TAG = /(^|[\s(>])#([\p{L}\p{N}_/-]+)/gu;
const BLOCK_REF = /\s*\^[\w-]+\s*$/gm;
const CODE_FENCE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE = /`[^`\n]+`/g;

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Title from `title:` frontmatter, else the first H1, else the filename. */
function deriveTitle(
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const fmTitle = frontmatter.title;
  if (typeof fmTitle === "string" && fmTitle.trim()) return fmTitle.trim();

  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();

  const filename = path.split("/").pop() ?? path;
  return filename.replace(/\.md$/i, "");
}

function toStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim().replace(/^#/, ""))
      .filter(Boolean);
  }
  return [];
}

/**
 * Collects #tags from the body, ignoring anything inside code, and normalising
 * away the leading `#`. Nested tags (`#area/eng`) are kept whole.
 */
function extractInlineTags(body: string): string[] {
  const stripped = body.replace(CODE_FENCE, " ").replace(INLINE_CODE, " ");
  const tags = new Set<string>();
  for (const match of stripped.matchAll(INLINE_TAG)) {
    const tag = match[2];
    // `#1` and `#2024` are almost always headings or numbers, not tags.
    if (/^\d+$/.test(tag)) continue;
    tags.add(tag.toLowerCase());
  }
  return [...tags];
}

/** Outgoing wikilink targets, with display aliases and heading anchors removed. */
function extractLinks(body: string): string[] {
  const stripped = body.replace(CODE_FENCE, " ").replace(INLINE_CODE, " ");
  const links = new Set<string>();
  for (const match of stripped.matchAll(WIKILINK)) {
    const target = match[1].split("|")[0].split("#")[0].split("^")[0].trim();
    if (target) links.add(target);
  }
  return [...links];
}

/**
 * Rewrites Obsidian syntax into something an LLM reads cleanly.
 * Link *text* is preserved because it carries meaning; the link plumbing is not.
 */
export function normaliseObsidianSyntax(body: string): string {
  return (
    body
      // ![[Embedded note]] -> a readable reference rather than a broken image.
      .replace(/!\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
        const target = String(inner).split("|")[0].split("#")[0].trim();
        return `[embedded: ${target}]`;
      })
      // [[Note|shown text]] -> shown text ; [[Note#Heading]] -> Note (Heading)
      .replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
        const [targetPart, alias] = String(inner).split("|");
        if (alias) return alias.trim();
        const [target, heading] = targetPart.split("#");
        return heading ? `${target.trim()} (${heading.trim()})` : target.trim();
      })
      // Callout headers: > [!note] Title -> > Note: Title
      .replace(/^>\s*\[!(\w+)\][+-]?\s*(.*)$/gm, (_m, kind: string, title: string) => {
        const label = kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();
        return `> ${label}${title ? `: ${title}` : ""}`;
      })
      // Trailing ^block-ids carry no meaning for a reader.
      .replace(BLOCK_REF, "")
      // Obsidian comments are explicitly not for publication.
      .replace(/%%[\s\S]*?%%/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export interface ParseOptions {
  respectPrivacyFrontmatter: boolean;
  privateTags: string[];
}

/**
 * Decides whether a note is excluded from retrieval.
 * Errs towards excluding: a false positive costs one note, a false negative
 * emails private content to a stranger.
 */
function isPrivateNote(
  frontmatter: Record<string, unknown>,
  tags: string[],
  options: ParseOptions,
): boolean {
  if (!options.respectPrivacyFrontmatter) return false;

  if (frontmatter.private === true || frontmatter.publish === false) return true;
  if (frontmatter.draft === true) return true;
  if (typeof frontmatter.visibility === "string" && frontmatter.visibility.toLowerCase() === "private") {
    return true;
  }

  const privateTags = options.privateTags.map((t) => t.toLowerCase().replace(/^#/, ""));
  return tags.some((tag) =>
    privateTags.some((p) => tag === p || tag.startsWith(`${p}/`)),
  );
}

function parseDate(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function parseNote(
  path: string,
  raw: string,
  options: ParseOptions,
  fileModifiedAt?: Date,
): ParsedNote {
  // `excerpt: false` keeps gray-matter from re-parsing the body as a delimiter.
  const { data, content } = matter(raw, { excerpt: false });
  const frontmatter = (data ?? {}) as Record<string, unknown>;

  const body = normaliseObsidianSyntax(content);
  const title = deriveTitle(path, frontmatter, content);

  const frontmatterTags = [
    ...toStringArray(frontmatter.tags),
    ...toStringArray(frontmatter.tag),
  ].map((t) => t.toLowerCase());

  const tags = [...new Set([...frontmatterTags, ...extractInlineTags(content)])];
  const aliases = [...toStringArray(frontmatter.aliases), ...toStringArray(frontmatter.alias)];

  return {
    path,
    title,
    body,
    frontmatter,
    tags,
    links: extractLinks(content),
    aliases,
    contentHash: sha256(raw),
    wordCount: body.split(/\s+/).filter(Boolean).length,
    isPrivate: isPrivateNote(frontmatter, tags, options),
    createdAt: parseDate(frontmatter.created ?? frontmatter.date ?? frontmatter["date created"]),
    updatedAt:
      parseDate(frontmatter.updated ?? frontmatter.modified ?? frontmatter["date modified"]) ??
      fileModifiedAt?.toISOString(),
  };
}

/** Notes with no usable prose after normalisation are not worth embedding. */
export function isIngestible(note: ParsedNote, minWords = 3): boolean {
  return note.body.trim().length > 0 && note.wordCount >= minWords;
}
