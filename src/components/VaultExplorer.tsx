"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  EyeOff,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Search,
} from "lucide-react";

/**
 * Vault file tree with a preview pane, laid out like Obsidian's own explorer.
 *
 * The preview shows the stored note body, not a reassembly of its chunks:
 * chunks carry a heading breadcrumb and overlap their neighbours, so stitching
 * them back together would show duplicated sentences that are not in the file.
 *
 * Chunk boundaries are shown separately, because when an answer quotes
 * something strange the cause is usually a bad split, and that is invisible
 * from the note text alone.
 */

interface NoteEntry {
  id: string;
  path: string;
  title: string;
  wordCount: number;
  isPrivate: boolean;
  updatedAt: string | null;
  tags: string[];
}

interface NoteDetail {
  id: string;
  path: string;
  title: string;
  body: string | null;
  frontmatter: Record<string, unknown>;
  tags: string[];
  links: string[];
  wordCount: number;
  isPrivate: boolean;
  updatedAt: string | null;
}

interface ChunkInfo {
  id: string;
  ordinal: number;
  headingPath: string[];
  tokenCount: number;
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  note?: NoteEntry;
}

function buildTree(notes: NoteEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };

  for (const note of notes) {
    const segments = note.path.split("/");
    let node = root;

    segments.forEach((segment, i) => {
      const isFile = i === segments.length - 1;
      const path = segments.slice(0, i + 1).join("/");

      if (!node.children.has(segment)) {
        node.children.set(segment, { name: segment, path, children: new Map() });
      }
      node = node.children.get(segment)!;
      if (isFile) node.note = note;
    });
  }
  return root;
}

/** Folders first, then files, each alphabetical — Obsidian's own ordering. */
function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    const aDir = !a.note;
    const bDir = !b.note;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export default function VaultExplorer({
  vaultId,
  noteCount,
}: {
  vaultId: string;
  noteCount: number;
}) {
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [chunks, setChunks] = useState<ChunkInfo[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showChunks, setShowChunks] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/vault/${vaultId}/notes`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Could not load notes.");

        setNotes(json.notes as NoteEntry[]);
        // Open the top level so the vault does not look empty on arrival.
        const top = new Set<string>();
        for (const n of json.notes as NoteEntry[]) {
          const first = n.path.split("/")[0];
          if (n.path.includes("/")) top.add(first);
        }
        setExpanded(top);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load notes.");
      } finally {
        setLoading(false);
      }
    })();
  }, [vaultId]);

  async function openNote(note: NoteEntry) {
    setSelectedId(note.id);
    setDetailLoading(true);
    setDetail(null);

    try {
      const res = await fetch(`/api/notes/${note.id}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not load the note.");
      setDetail(json.note as NoteDetail);
      setChunks(json.chunks as ChunkInfo[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the note.");
    } finally {
      setDetailLoading(false);
    }
  }

  const visible = useMemo(() => {
    if (!filter.trim()) return notes;
    const term = filter.toLowerCase();
    return notes.filter(
      (n) => n.path.toLowerCase().includes(term) || n.title.toLowerCase().includes(term),
    );
  }, [notes, filter]);

  const tree = useMemo(() => buildTree(visible), [visible]);
  // A filtered tree with collapsed folders hides its own results.
  const forceOpen = filter.trim().length > 0;

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderNode(node: TreeNode, depth: number): React.ReactNode {
    if (node.note) {
      const active = node.note.id === selectedId;
      return (
        <button
          key={node.path}
          onClick={() => openNote(node.note!)}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          className={`flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-[13px] transition-colors ${
            active
              ? "bg-[var(--color-surface-3)] text-[var(--color-ink)]"
              : "text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
          }`}
          title={node.note.path}
        >
          <FileText size={13} className="shrink-0 opacity-60" />
          <span className="truncate">{node.name.replace(/\.(md|markdown|mdx)$/i, "")}</span>
          {node.note.isPrivate && (
            <EyeOff size={11} className="ml-auto shrink-0 text-[var(--color-warn)]" />
          )}
        </button>
      );
    }

    const isOpen = forceOpen || expanded.has(node.path);
    return (
      <div key={node.path}>
        <button
          onClick={() => toggle(node.path)}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          className="flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-[13px] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
        >
          <ChevronRight
            size={12}
            className={`shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`}
          />
          {isOpen ? (
            <FolderOpen size={13} className="shrink-0 opacity-60" />
          ) : (
            <Folder size={13} className="shrink-0 opacity-60" />
          )}
          <span className="truncate">{node.name}</span>
        </button>

        {isOpen && sortedChildren(node).map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="card flex items-center gap-2 text-sm text-[var(--color-muted)]">
        <Loader2 size={14} className="animate-spin" /> Loading {noteCount} notes…
      </div>
    );
  }

  if (error && notes.length === 0) {
    return <div className="callout callout-bad">{error}</div>;
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(220px,300px)_1fr]">
      {/* ------------------------------------------------------------ tree -- */}
      <div className="card flex max-h-[70vh] flex-col overflow-hidden p-0">
        <div className="border-b border-[var(--color-border-soft)] p-2.5">
          <div className="relative">
            <Search
              size={12}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-faint)]"
            />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter notes…"
              className="input py-1.5 pl-7 text-xs"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-1.5">
          {visible.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-[var(--color-muted)]">
              No notes match.
            </p>
          ) : (
            sortedChildren(tree).map((child) => renderNode(child, 0))
          )}
        </div>

        <div className="border-t border-[var(--color-border-soft)] px-3 py-2 text-[11px] text-[var(--color-faint)]">
          {visible.length} of {notes.length} notes
        </div>
      </div>

      {/* --------------------------------------------------------- preview -- */}
      <div className="card flex max-h-[70vh] flex-col overflow-hidden p-0">
        {!selectedId ? (
          <div className="flex flex-1 items-center justify-center p-10 text-center">
            <p className="text-sm text-[var(--color-muted)]">
              Select a note to preview what was indexed.
            </p>
          </div>
        ) : detailLoading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-[var(--color-muted)]">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : detail ? (
          <>
            <div className="border-b border-[var(--color-border-soft)] px-4 py-3">
              <h3 className="text-sm font-medium">{detail.title}</h3>
              <p className="mt-0.5 truncate text-xs text-[var(--color-faint)]">{detail.path}</p>

              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-muted)]">
                <span>{detail.wordCount} words</span>
                <span>·</span>
                <span>
                  {chunks.length} chunk{chunks.length === 1 ? "" : "s"}
                </span>
                {detail.updatedAt && (
                  <>
                    <span>·</span>
                    <span>{new Date(detail.updatedAt).toLocaleDateString()}</span>
                  </>
                )}
                {detail.tags.slice(0, 6).map((t) => (
                  <span key={t} className="badge border-[var(--color-border)]">
                    #{t}
                  </span>
                ))}
              </div>

              {detail.isPrivate && (
                <div className="callout callout-warn mt-2.5">
                  Private note — recorded but never chunked, embedded, or quoted in a reply.
                </div>
              )}

              {chunks.length > 0 && (
                <button
                  onClick={() => setShowChunks((v) => !v)}
                  className="mt-2 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                >
                  {showChunks ? "Hide" : "Show"} chunk boundaries
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3">
              {showChunks ? (
                <div className="space-y-2">
                  {chunks.map((c) => (
                    <div key={c.id} className="rounded border border-[var(--color-border-soft)] p-2.5">
                      <p className="mb-1 text-[11px] text-[var(--color-accent-soft)]">
                        chunk {c.ordinal + 1} · {c.tokenCount} tokens
                      </p>
                      <p className="text-[11px] text-[var(--color-faint)]">
                        {c.headingPath.join(" › ") || "(no heading)"}
                      </p>
                    </div>
                  ))}
                </div>
              ) : detail.body ? (
                <pre className="note-text whitespace-pre-wrap break-words text-[var(--color-ink)]">
                  {detail.body}
                </pre>
              ) : (
                <div className="callout callout-warn">
                  No stored body. Notes indexed before the preview feature was added have no
                  copy of their text — re-index this vault to populate it.
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
