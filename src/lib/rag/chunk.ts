import { sha256 } from "@/lib/rag/markdown";
import { countTokens } from "@/lib/rag/tokenize";
import type { Chunk } from "@/lib/types";

/**
 * Structure-aware chunking for Obsidian notes.
 *
 * The defaults (512 tokens, 64 overlap) are the range that consistently works
 * best for note-shaped prose: large enough that a chunk answers a question on
 * its own, small enough that a 1024-dim embedding is not averaging six unrelated
 * ideas into one vector.
 *
 * Three choices matter more than the numbers:
 *
 *  1. Split on heading structure first, then pack to size. An author's headings
 *     are a free, human-authored topic segmentation — better than any fixed
 *     window, and it keeps a section's sentences in the same vector.
 *  2. Never split inside a fenced code block or table. Half a code block is
 *     worse than useless: it retrieves well and then misleads the reader.
 *  3. Prepend the "Note > H1 > H2" breadcrumb to every chunk. A chunk that says
 *     "set it to 3" is unretrievable; "Retry policy > Defaults: set it to 3" is
 *     not, and it costs ~10 tokens.
 */

export interface ChunkOptions {
  strategy: "markdown" | "recursive";
  sizeTokens: number;
  overlapTokens: number;
  minTokens: number;
  maxTokens: number;
  prependHeadings: boolean;
  keepCodeBlocks: boolean;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  strategy: "markdown",
  sizeTokens: 512,
  overlapTokens: 64,
  minTokens: 48,
  maxTokens: 1024,
  prependHeadings: true,
  keepCodeBlocks: true,
};

type BlockType = "heading" | "code" | "table" | "list" | "text";

interface Block {
  type: BlockType;
  text: string;
  start: number;
  end: number;
  /** Heading depth, only for `heading` blocks. */
  level?: number;
}

/**
 * Splits markdown into atomic blocks, keeping fenced code and tables whole.
 * Offsets are into the original body so chunks can be traced back to source.
 */
function splitIntoBlocks(body: string, keepCodeBlocks: boolean): Block[] {
  const lines = body.split("\n");
  const blocks: Block[] = [];

  let offset = 0;
  let buffer: string[] = [];
  let bufferStart = 0;
  let bufferType: BlockType = "text";

  const flush = (end: number) => {
    const text = buffer.join("\n").trim();
    if (text) blocks.push({ type: bufferType, text, start: bufferStart, end });
    buffer = [];
    bufferType = "text";
  };

  let inFence = false;
  let fenceMarker = "";

  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1; // +1 for the newline

    const fenceMatch = line.match(/^(\s*)(```+|~~~+)/);

    if (inFence) {
      buffer.push(line);
      if (fenceMatch && fenceMatch[2].startsWith(fenceMarker)) {
        inFence = false;
        flush(lineEnd);
      }
      continue;
    }

    if (fenceMatch && keepCodeBlocks) {
      flush(lineStart);
      inFence = true;
      fenceMarker = fenceMatch[2];
      bufferType = "code";
      bufferStart = lineStart;
      buffer.push(line);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flush(lineStart);
      blocks.push({
        type: "heading",
        text: line.trim(),
        start: lineStart,
        end: lineEnd,
        level: headingMatch[1].length,
      });
      bufferStart = offset;
      continue;
    }

    // A table row starting a new block switches the buffer type so the whole
    // table stays together even across a blank-line-free run.
    const isTableRow = /^\s*\|.*\|\s*$/.test(line);
    if (isTableRow && buffer.length === 0) {
      bufferType = "table";
      bufferStart = lineStart;
    }

    if (line.trim() === "" && bufferType !== "table") {
      flush(lineStart);
      bufferStart = offset;
      continue;
    }

    if (buffer.length === 0) bufferStart = lineStart;
    buffer.push(line);
  }

  flush(offset);
  return blocks;
}

/** Splits oversized prose on paragraph, then sentence, then word boundaries. */
function splitOversized(text: string, maxTokens: number): string[] {
  if (countTokens(text) <= maxTokens) return [text];

  const separators = [/\n\n+/, /(?<=[.!?])\s+(?=[A-Z"'\[(])/, /\n/, /\s+/];

  for (const separator of separators) {
    const parts = text.split(separator).filter((p) => p.trim());
    if (parts.length < 2) continue;

    const out: string[] = [];
    let current = "";

    for (const part of parts) {
      const candidate = current ? `${current}\n\n${part}` : part;
      if (countTokens(candidate) > maxTokens && current) {
        out.push(current);
        current = part;
      } else {
        current = candidate;
      }
    }
    if (current) out.push(current);

    // Recurse for any piece still too large under this separator.
    if (out.every((p) => countTokens(p) <= maxTokens)) return out;
    return out.flatMap((p) =>
      countTokens(p) > maxTokens ? splitOversized(p, maxTokens) : [p],
    );
  }

  // Nothing left to split on (one enormous token run) — cut by characters.
  const approxChars = Math.max(1, Math.floor(maxTokens * 3.5));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += approxChars) out.push(text.slice(i, i + approxChars));
  return out;
}

/** Takes whole trailing sentences from `text` up to `overlapTokens`. */
function tailForOverlap(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return "";

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const tail: string[] = [];
  let tokens = 0;

  for (let i = sentences.length - 1; i >= 0; i--) {
    const t = countTokens(sentences[i]);
    if (tokens + t > overlapTokens) break;
    tail.unshift(sentences[i]);
    tokens += t;
  }

  return tail.join(" ");
}

function breadcrumb(noteTitle: string, headings: string[]): string[] {
  return [noteTitle, ...headings].filter(Boolean);
}

/**
 * Chunks a normalised note body.
 *
 * @param noteTitle used for the breadcrumb prefix
 * @param body      markdown with Obsidian syntax already normalised
 */
export function chunkNote(
  noteTitle: string,
  body: string,
  options: Partial<ChunkOptions> = {},
): Chunk[] {
  const opts = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const trimmed = body.trim();
  if (!trimmed) return [];

  const blocks =
    opts.strategy === "markdown"
      ? splitIntoBlocks(trimmed, opts.keepCodeBlocks)
      : [{ type: "text" as BlockType, text: trimmed, start: 0, end: trimmed.length }];

  const chunks: Chunk[] = [];
  // headingStack[i] is the most recent heading at depth i+1.
  const headingStack: string[] = [];

  let pending: { text: string; start: number; end: number; headings: string[] }[] = [];
  let pendingTokens = 0;

  const emit = () => {
    if (pending.length === 0) return;

    const headings = pending[0].headings;
    const rawText = pending.map((p) => p.text).join("\n\n");
    const start = pending[0].start;
    const end = pending[pending.length - 1].end;

    // Carry the tail of the previous chunk forward so a sentence split across a
    // boundary is still retrievable from either side.
    const previous = chunks[chunks.length - 1];
    const sameNote = previous !== undefined;
    const overlap =
      sameNote && opts.overlapTokens > 0 ? tailForOverlap(previous.content, opts.overlapTokens) : "";

    const crumb = breadcrumb(noteTitle, headings);
    const prefix = opts.prependHeadings && crumb.length ? `${crumb.join(" > ")}\n\n` : "";
    const content = `${prefix}${overlap ? `${overlap}\n\n` : ""}${rawText}`.trim();

    chunks.push({
      ordinal: chunks.length,
      headingPath: crumb,
      content,
      tokenCount: countTokens(content),
      charStart: start,
      charEnd: end,
      contentHash: sha256(content),
    });

    pending = [];
    pendingTokens = 0;
  };

  for (const block of blocks) {
    if (block.type === "heading") {
      // A new heading ends the current chunk: sections are the natural boundary.
      emit();
      const level = block.level ?? 1;
      const text = block.text.replace(/^#{1,6}\s+/, "").trim();
      headingStack.length = Math.min(headingStack.length, level - 1);
      headingStack[level - 1] = text;
      // Clear any deeper headings left over from the previous section.
      headingStack.length = level;
      continue;
    }

    const headings = headingStack.filter(Boolean);
    const blockTokens = countTokens(block.text);

    // Oversized single block: flush, then emit its pieces directly.
    if (blockTokens > opts.maxTokens) {
      emit();
      const pieces =
        block.type === "code" && opts.keepCodeBlocks
          ? // A code block over the limit still has to be split, but only at line
            // boundaries so each piece stays syntactically readable.
            splitOversized(block.text, opts.maxTokens)
          : splitOversized(block.text, opts.sizeTokens);

      for (const piece of pieces) {
        pending = [{ text: piece, start: block.start, end: block.end, headings }];
        pendingTokens = countTokens(piece);
        emit();
      }
      continue;
    }

    if (pendingTokens + blockTokens > opts.sizeTokens && pending.length > 0) {
      emit();
    }

    pending.push({ text: block.text, start: block.start, end: block.end, headings });
    pendingTokens += blockTokens;
  }

  emit();

  return mergeUndersized(chunks, opts);
}

/**
 * Folds chunks below `minTokens` into a neighbour.
 *
 * A 12-token chunk ("## Notes" plus one line) embeds to a vector dominated by
 * noise and pollutes retrieval, so it is better attached to its neighbour than
 * indexed alone.
 */
function mergeUndersized(chunks: Chunk[], opts: ChunkOptions): Chunk[] {
  if (chunks.length <= 1) return chunks;

  const out: Chunk[] = [];

  for (const chunk of chunks) {
    const previous = out[out.length - 1];
    const tooSmall = chunk.tokenCount < opts.minTokens;
    const fits = previous && previous.tokenCount + chunk.tokenCount <= opts.maxTokens;

    if (tooSmall && previous && fits) {
      const content = `${previous.content}\n\n${chunk.content}`;
      out[out.length - 1] = {
        ...previous,
        content,
        tokenCount: countTokens(content),
        charEnd: chunk.charEnd,
        contentHash: sha256(content),
      };
      continue;
    }
    out.push(chunk);
  }

  // Ordinals must stay dense and 0-based: neighbour-window expansion in
  // `chunk_neighbors` walks ordinal ranges.
  return out.map((c, i) => ({ ...c, ordinal: i }));
}

/** Summary used by the ingest report and the chunking preview in the UI. */
export function chunkStats(chunks: Chunk[]) {
  if (chunks.length === 0) return { count: 0, totalTokens: 0, meanTokens: 0, maxTokens: 0, minTokens: 0 };
  const tokens = chunks.map((c) => c.tokenCount);
  const total = tokens.reduce((a, b) => a + b, 0);
  return {
    count: chunks.length,
    totalTokens: total,
    meanTokens: Math.round(total / chunks.length),
    maxTokens: Math.max(...tokens),
    minTokens: Math.min(...tokens),
  };
}
