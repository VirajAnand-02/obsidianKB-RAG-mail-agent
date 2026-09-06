"use client";

import { useState } from "react";
import { Check, Database, Loader2, RefreshCw, Repeat, Star, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";

import VaultExplorer from "@/components/VaultExplorer";

/**
 * Vault picker plus explorer.
 *
 * With more than one vault the list becomes selectable, so the file browser can
 * be pointed at any of them. Selection is local state rather than a route
 * param: it is a view preference, not something worth a navigation.
 *
 * The default vault is what answers email; the selected one is only what you
 * are looking at. Those are deliberately separate, and the star makes the
 * distinction visible.
 */

export interface VaultSummary {
  id: string;
  name: string;
  status: string;
  isDefault: boolean;
  hasArchive: boolean;
  error: string | null;
  stats: { notes?: number; chunks?: number; tokens?: number; private?: number; attachments?: number };
}

const STATUS_STYLE: Record<string, string> = {
  ready: "border-[#1a4d2e] text-[var(--color-ok)]",
  failed: "border-[#5c2229] text-[var(--color-bad)]",
};

export default function VaultSwitcher({ vaults }: { vaults: VaultSummary[] }) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(
    vaults.find((v) => v.isDefault)?.id ?? vaults[0]?.id,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  // Deleting is irreversible, so the button arms itself before it fires.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const selected = vaults.find((v) => v.id === selectedId) ?? vaults[0];
  if (!selected) return null;

  async function reindex(mode: "reembed" | "full") {
    setBusy(mode);
    setMessage("");
    try {
      const res = await fetch(`/api/vault/${selected.id}/reingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed.");
      setMessage(
        mode === "reembed"
          ? `Re-embedded ${json.chunks} chunks.`
          : `Re-indexed ${json.stats?.notesIndexed ?? 0} notes.`,
      );
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    setMessage("");

    try {
      const res = await fetch(`/api/vault/${selected.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Delete failed.");

      // Move the view off the vault that no longer exists before refreshing.
      const remaining = vaults.filter((v) => v.id !== selected.id);
      setSelectedId(remaining[0]?.id);
      setConfirmingDelete(false);
      setMessage(
        `Deleted ${json.name} (${json.notes} notes, ${json.chunks} chunks)` +
          (json.promoted ? ` — ${json.promoted} now answers email.` : "."),
      );
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setBusy(null);
    }
  }

  async function makeDefault(id: string) {
    setBusy("default");
    try {
      await fetch(`/api/vault/${id}/default`, { method: "POST" });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {vaults.length > 1 && (
        <div className="card mb-3 p-2">
          <div className="stagger flex flex-wrap gap-1.5">
            {vaults.map((v) => {
              const active = v.id === selected.id;
              return (
                <button
                  key={v.id}
                  onClick={() => setSelectedId(v.id)}
                  className={`press flex items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                    active
                      ? "border-[var(--color-accent)] bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                      : "border-[var(--color-border-soft)] text-[var(--color-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
                  }`}
                >
                  {active ? (
                    <Check size={13} className="text-[var(--color-accent-soft)]" />
                  ) : (
                    <Database size={13} className="opacity-60" />
                  )}
                  <span className="font-medium">{v.name}</span>
                  <span className="opacity-60">{v.stats.notes ?? 0}</span>
                  {v.isDefault && (
                    <Star size={11} className="fill-current text-[var(--color-warn)]" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div key={selected.id} className="animate-fade-in">
        <div className="card mb-3 flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium">
              {selected.name}
              {selected.isDefault ? (
                <span className="badge text-[var(--color-warn)]">
                  <Star size={9} className="fill-current" /> answers email
                </span>
              ) : (
                <button
                  onClick={() => makeDefault(selected.id)}
                  disabled={busy !== null}
                  className="badge press text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                  title="Use this vault to answer incoming email"
                >
                  make default
                </button>
              )}
              <span className={`badge ${STATUS_STYLE[selected.status] ?? "text-[var(--color-warn)]"}`}>
                {selected.status}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-[var(--color-muted)]">
              {selected.stats.notes ?? 0} notes · {selected.stats.chunks ?? 0} chunks ·{" "}
              {(selected.stats.tokens ?? 0).toLocaleString()} tokens
              {selected.stats.private ? ` · ${selected.stats.private} private` : ""}
            </p>
            {selected.error && (
              <p className="mt-1.5 text-xs text-[var(--color-bad)]">{selected.error}</p>
            )}
          </div>

          <div className="flex flex-col items-end gap-1.5">
            <div className="flex gap-2">
              <button
                onClick={() => reindex("reembed")}
                disabled={busy !== null}
                className="btn-ghost press text-xs"
                title="Regenerate vectors, keeping existing chunk text"
              >
                {busy === "reembed" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Repeat size={13} />
                )}
                Re-embed
              </button>
              <button
                onClick={() => reindex("full")}
                disabled={busy !== null || !selected.hasArchive}
                className="btn-ghost press text-xs"
                title={
                  selected.hasArchive
                    ? "Re-extract and re-chunk from the stored archive"
                    : "No stored archive — upload this vault again to enable"
                }
              >
                {busy === "full" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <RefreshCw size={13} />
                )}
                Re-index
              </button>

              {confirmingDelete ? (
                <>
                  <button
                    onClick={remove}
                    disabled={busy !== null}
                    className="btn-danger press animate-slide-down text-xs"
                    title={`Permanently delete ${selected.name} and everything indexed from it`}
                  >
                    {busy === "delete" ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}
                    Delete {selected.stats.notes ?? 0} notes?
                  </button>
                  <button
                    onClick={() => setConfirmingDelete(false)}
                    disabled={busy !== null}
                    className="btn-ghost press text-xs"
                    aria-label="Cancel delete"
                  >
                    <X size={13} />
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmingDelete(true)}
                  disabled={busy !== null}
                  className="btn-ghost press text-xs text-[var(--color-muted)] hover:text-[var(--color-bad)]"
                  title="Delete this vault"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
            {message && (
              <p className="animate-fade-in text-xs text-[var(--color-muted)]">{message}</p>
            )}
          </div>
        </div>

        <VaultExplorer vaultId={selected.id} noteCount={selected.stats.notes ?? 0} />
      </div>
    </>
  );
}
