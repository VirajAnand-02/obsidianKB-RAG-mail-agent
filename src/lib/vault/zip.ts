import { unzip, type Unzipped } from "fflate";
import { appConfig } from "@/lib/app-config";
import { createLogger } from "@/lib/logger";

const log = createLogger("vault:zip");

/**
 * Vault archive extraction.
 *
 * Obsidian vaults are plain directories, so an upload is either a zip or a
 * browser directory selection. Both funnel into the same `VaultFile[]` shape.
 */

export interface VaultFile {
  /** Vault-relative POSIX path, with any wrapper directory stripped. */
  path: string;
  content: string;
  bytes: number;
}

export interface ExtractResult {
  files: VaultFile[];
  skipped: { path: string; reason: string }[];
  attachments: number;
  totalBytes: number;
}

/**
 * Minimal glob matcher covering the patterns used in INGEST_EXCLUDE_GLOBS:
 * `**` (any depth), `*` (within one segment), and `?`.
 *
 * Translated in a single pass rather than by chained `.replace()` calls: a
 * later pass rewriting `*` would otherwise corrupt the `.*` emitted by an
 * earlier `**` pass, silently turning `.obsidian/**` into a pattern that
 * matches nothing.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  let expression = "";

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          // `**/` spans any number of directories, including none.
          expression += "(?:.*/)?";
          i += 2;
        } else {
          expression += ".*";
          i += 1;
        }
      } else {
        // A single `*` stays inside one path segment.
        expression += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      expression += "[^/]";
      continue;
    }

    expression += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  return new RegExp(`^${expression}$`).test(path);
}

export function isExcluded(path: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(path, p));
}

/**
 * Zips of an Obsidian vault usually contain a single wrapper directory
 * ("MyVault/..."). Detecting and stripping it keeps stored note paths matching
 * what the user sees in Obsidian, which matters because paths appear in emails.
 */
export function stripCommonPrefix(paths: string[]): string {
  if (paths.length === 0) return "";

  const segments = paths.map((p) => p.split("/"));
  const first = segments[0];
  if (first.length < 2) return "";

  const candidate = first[0];
  const shared = segments.every((s) => s.length > 1 && s[0] === candidate);
  return shared ? `${candidate}/` : "";
}

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"];

function isMarkdown(path: string): boolean {
  return MARKDOWN_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));
}

/** Names that are noise in every vault regardless of user configuration. */
function isSystemFile(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return (
    name === ".DS_Store" ||
    name === "Thumbs.db" ||
    name.startsWith("._") ||
    path.startsWith("__MACOSX/")
  );
}

function unzipAsync(data: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(data, (err, unzipped) => (err ? reject(err) : resolve(unzipped)));
  });
}

export interface ExtractOptions {
  excludeGlobs?: string[];
  maxBytes?: number;
}

/**
 * Extracts markdown notes from a zipped vault.
 * Non-markdown entries are counted as attachments and dropped: this system
 * answers from prose, and embedding a PNG's bytes helps nobody.
 */
export async function extractVaultZip(
  archive: Uint8Array | ArrayBuffer,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const bytes = archive instanceof Uint8Array ? archive : new Uint8Array(archive);
  const maxBytes = options.maxBytes ?? appConfig.ingestion.maxVaultUploadMb * 1024 * 1024;

  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `Vault archive is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${(maxBytes / 1024 / 1024).toFixed(0)} MB limit. Raise MAX_VAULT_UPLOAD_MB or ` +
        `remove attachments before zipping.`,
    );
  }

  let unzipped: Unzipped;
  try {
    unzipped = await unzipAsync(bytes);
  } catch (e) {
    throw new Error(
      `Could not read the archive — is it a valid .zip? (${e instanceof Error ? e.message : e})`,
    );
  }

  const excludeGlobs = options.excludeGlobs ?? [...appConfig.ingestion.excludeGlobs];
  // Directory entries have empty contents and a trailing slash.
  const entryPaths = Object.keys(unzipped).filter((p) => !p.endsWith("/"));
  const prefix = stripCommonPrefix(entryPaths);

  const files: VaultFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let attachments = 0;
  let totalBytes = 0;

  const decoder = new TextDecoder("utf-8", { fatal: false });

  for (const rawPath of entryPaths) {
    const path = (prefix && rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath)
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");

    if (!path || isSystemFile(path)) continue;

    if (isExcluded(path, excludeGlobs)) {
      skipped.push({ path, reason: "excluded by INGEST_EXCLUDE_GLOBS" });
      continue;
    }

    if (!isMarkdown(path)) {
      attachments++;
      continue;
    }

    const data = unzipped[rawPath];
    totalBytes += data.byteLength;
    files.push({ path, content: decoder.decode(data), bytes: data.byteLength });
  }

  log.info("Extracted vault archive", {
    notes: files.length,
    attachments,
    skipped: skipped.length,
  });

  return { files, skipped, attachments, totalBytes };
}

/**
 * Normalises a browser directory upload (`<input webkitdirectory>`) into the
 * same shape as a zip extraction.
 */
export async function extractVaultFiles(
  entries: { path: string; content: string; bytes?: number }[],
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const excludeGlobs = options.excludeGlobs ?? [...appConfig.ingestion.excludeGlobs];
  const prefix = stripCommonPrefix(entries.map((e) => e.path));

  const files: VaultFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let attachments = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    const path = (
      prefix && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path
    ).replace(/\\/g, "/");

    if (!path || isSystemFile(path)) continue;

    if (isExcluded(path, excludeGlobs)) {
      skipped.push({ path, reason: "excluded by INGEST_EXCLUDE_GLOBS" });
      continue;
    }
    if (!isMarkdown(path)) {
      attachments++;
      continue;
    }

    const bytes = entry.bytes ?? Buffer.byteLength(entry.content, "utf8");
    totalBytes += bytes;
    files.push({ path, content: entry.content, bytes });
  }

  return { files, skipped, attachments, totalBytes };
}
