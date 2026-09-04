"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FolderOpen, FileArchive, Loader2 } from "lucide-react";

/**
 * Vault upload.
 *
 * Two modes, because Obsidian vaults are plain folders and neither shape covers
 * everyone: a zip (works everywhere, survives as a re-ingestable archive) and a
 * direct folder pick via `webkitdirectory` (no zipping step, Chromium only).
 *
 * The folder path is sent alongside each file because a File's `name` loses the
 * directory structure, and note paths are what citations and email footers show.
 */
export default function VaultUpload() {
  const router = useRouter();
  const zipInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("My Vault");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  async function upload(form: FormData) {
    setBusy(true);
    setError("");
    setResult(null);
    setStatus("Uploading and indexing — this can take a few minutes for a large vault.");

    try {
      const res = await fetch("/api/vault/upload", { method: "POST", body: form });
      const json = await res.json();

      if (!res.ok) throw new Error(json.error ?? "Upload failed.");

      setResult(json.stats ?? json);
      setStatus("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  function submitZip() {
    const file = zipInput.current?.files?.[0];
    if (!file) return setError("Choose a .zip file first.");

    const form = new FormData();
    form.append("name", name.trim() || "My Vault");
    form.append("file", file);
    void upload(form);
  }

  function submitFolder() {
    const files = Array.from(dirInput.current?.files ?? []);
    const markdown = files.filter((f) => /\.(md|markdown|mdx)$/i.test(f.name));

    if (markdown.length === 0) {
      return setError("That folder contains no markdown files.");
    }

    const form = new FormData();
    form.append("name", name.trim() || "My Vault");
    for (const file of markdown) {
      form.append("files", file);
      // webkitRelativePath preserves the in-vault path; file.name does not.
      form.append("paths", (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
    }
    void upload(form);
  }

  return (
    <div className="card">
      <h2 className="font-medium">Upload a vault</h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Markdown notes are indexed; attachments are skipped. Notes marked{" "}
        <code>private: true</code> or tagged <code>#private</code> are never embedded.
      </p>

      <div className="mt-5">
        <label className="label" htmlFor="vault-name">
          Vault name
        </label>
        <input
          id="vault-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <FileArchive size={16} /> Zip archive
          </div>
          <p className="mb-3 text-xs text-[var(--color-muted)]">
            Works in every browser. Kept so the vault can be re-indexed later without
            re-uploading.
          </p>
          <input
            ref={zipInput}
            type="file"
            accept=".zip,application/zip"
            disabled={busy}
            className="w-full text-xs text-[var(--color-muted)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--color-surface-2)] file:px-3 file:py-1.5 file:text-xs file:text-[var(--color-ink)]"
          />
          <button onClick={submitZip} disabled={busy} className="btn-primary mt-3 w-full">
            Upload zip
          </button>
        </div>

        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <FolderOpen size={16} /> Vault folder
          </div>
          <p className="mb-3 text-xs text-[var(--color-muted)]">
            Pick the vault directly. Chromium-based browsers only.
          </p>
          <input
            ref={dirInput}
            type="file"
            // Not standard React props; set via attributes for directory picking.
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            multiple
            disabled={busy}
            className="w-full text-xs text-[var(--color-muted)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--color-surface-2)] file:px-3 file:py-1.5 file:text-xs file:text-[var(--color-ink)]"
          />
          <button onClick={submitFolder} disabled={busy} className="btn-ghost mt-3 w-full">
            Upload folder
          </button>
        </div>
      </div>

      {busy && (
        <p className="mt-4 flex items-center gap-2 text-sm text-[var(--color-muted)]">
          <Loader2 size={14} className="animate-spin" /> {status}
        </p>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-[#5c2a2a] bg-[#2a1516] p-3 text-sm text-[var(--color-bad)]">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-lg border border-[#1f4d2a] bg-[#12261a] p-3 text-sm">
          <p className="font-medium text-[var(--color-ok)]">Vault indexed</p>
          <p className="mt-1 text-[var(--color-muted)]">
            {String(result.notesIndexed ?? 0)} notes indexed ·{" "}
            {String(result.chunksCreated ?? 0)} chunks ·{" "}
            {String(result.notesSkipped ?? 0)} skipped ·{" "}
            {String(result.notesPrivate ?? 0)} private
            {Number(result.notesFailed ?? 0) > 0 && ` · ${String(result.notesFailed)} failed`}
          </p>
        </div>
      )}
    </div>
  );
}
