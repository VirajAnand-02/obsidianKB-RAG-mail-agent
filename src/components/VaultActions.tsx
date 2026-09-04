"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Repeat } from "lucide-react";

/**
 * Re-index controls.
 *
 * The two modes are genuinely different jobs and the distinction matters:
 * re-embedding reuses existing chunk text, while a full re-ingest re-splits the
 * notes. Changing chunk size needs the latter — otherwise the old boundaries
 * survive and the setting appears to do nothing.
 */
export default function VaultActions({
  vaultId,
  hasArchive,
}: {
  vaultId: string;
  hasArchive: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"reembed" | "full" | null>(null);
  const [message, setMessage] = useState("");

  async function run(mode: "reembed" | "full") {
    setBusy(mode);
    setMessage("");

    try {
      const res = await fetch(`/api/vault/${vaultId}/reingest`, {
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

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <button onClick={() => run("reembed")} disabled={busy !== null} className="btn-ghost text-xs">
          {busy === "reembed" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Repeat size={13} />
          )}
          Re-embed
        </button>

        <button
          onClick={() => run("full")}
          disabled={busy !== null || !hasArchive}
          title={hasArchive ? "Re-extract and re-chunk from the stored archive" : "No stored archive — upload the vault again"}
          className="btn-ghost text-xs"
        >
          {busy === "full" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Re-index
        </button>
      </div>

      {message && <p className="text-xs text-[var(--color-muted)]">{message}</p>}
    </div>
  );
}
