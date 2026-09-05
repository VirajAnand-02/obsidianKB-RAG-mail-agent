"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, FileArchive, FolderOpen, Loader2, Upload } from "lucide-react";

/**
 * Vault upload as one button with a source dropdown.
 *
 * Both sources end at the same endpoint; they differ only in what the browser
 * can hand over. A zip works everywhere and is archived so the vault can be
 * re-indexed later without re-uploading; a folder pick skips the zipping step
 * but is Chromium-only and sends nothing that can be replayed.
 */
export default function UploadMenu({ hasVault }: { hasVault: boolean }) {
  const router = useRouter();
  const zipInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  // Close on outside click and Escape, the way a menu is expected to behave.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function upload(form: FormData) {
    setBusy(true);
    setError("");
    setResult(null);

    try {
      const res = await fetch("/api/vault/upload", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed.");

      setResult(json.stats ?? json);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  function onZipPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const form = new FormData();
    form.append("name", file.name.replace(/\.zip$/i, "") || "My Vault");
    form.append("file", file);
    void upload(form);
    e.target.value = "";
  }

  function onFolderPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    const markdown = files.filter((f) => /\.(md|markdown|mdx)$/i.test(f.name));

    if (markdown.length === 0) {
      setError("That folder contains no markdown files.");
      e.target.value = "";
      return;
    }

    // The vault name is the top folder; webkitRelativePath is the only place
    // the directory structure survives.
    const firstPath =
      (markdown[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    const form = new FormData();
    form.append("name", firstPath.split("/")[0] || "My Vault");

    for (const file of markdown) {
      form.append("files", file);
      form.append(
        "paths",
        (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      );
    }

    void upload(form);
    e.target.value = "";
  }

  return (
    <div className="relative" ref={wrapper}>
      <input
        ref={zipInput}
        type="file"
        accept=".zip,application/zip"
        onChange={onZipPicked}
        className="hidden"
      />
      <input
        ref={dirInput}
        type="file"
        // Not standard React props; set as attributes for directory picking.
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        multiple
        onChange={onFolderPicked}
        className="hidden"
      />

      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="btn-primary"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
        {busy ? "Indexing…" : hasVault ? "Upload vault" : "Upload a vault"}
        <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && !busy && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1.5 w-72 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-xl"
        >
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              zipInput.current?.click();
            }}
            className="flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-[var(--color-surface-3)]"
          >
            <FileArchive size={15} className="mt-0.5 shrink-0 text-[var(--color-accent-soft)]" />
            <span>
              <span className="block text-sm">Zip archive</span>
              <span className="block text-xs text-[var(--color-muted)]">
                Works in any browser. Kept so the vault can be re-indexed later.
              </span>
            </span>
          </button>

          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              dirInput.current?.click();
            }}
            className="flex w-full items-start gap-3 border-t border-[var(--color-border-soft)] px-3.5 py-3 text-left transition-colors hover:bg-[var(--color-surface-3)]"
          >
            <FolderOpen size={15} className="mt-0.5 shrink-0 text-[var(--color-accent-soft)]" />
            <span>
              <span className="block text-sm">Vault folder</span>
              <span className="block text-xs text-[var(--color-muted)]">
                Pick the folder directly. Chromium browsers only.
              </span>
            </span>
          </button>
        </div>
      )}

      {(error || result) && (
        <div className="absolute right-0 z-10 mt-1.5 w-80">
          {error && <div className="callout callout-bad">{error}</div>}
          {result && (
            <div className="callout callout-ok">
              {String(result.notesIndexed ?? 0)} notes · {String(result.chunksCreated ?? 0)} chunks
              {Number(result.notesPrivate ?? 0) > 0 &&
                ` · ${String(result.notesPrivate)} private excluded`}
              {Number(result.notesFailed ?? 0) > 0 && ` · ${String(result.notesFailed)} failed`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
