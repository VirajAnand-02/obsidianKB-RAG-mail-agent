import UploadMenu from "@/components/UploadMenu";
import VaultActions from "@/components/VaultActions";
import VaultExplorer from "@/components/VaultExplorer";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getRuntimeConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function VaultPage() {
  const db = supabaseAdmin();
  const config = await getRuntimeConfig();

  const [{ data: vaults }, { data: runs }, { data: spaces }] = await Promise.all([
    db.from("vaults").select("*").order("created_at", { ascending: false }),
    db.from("ingest_runs").select("*").order("started_at", { ascending: false }).limit(5),
    db.from("embedding_spaces").select("*").order("created_at", { ascending: false }),
  ]);

  const activeSpace = (spaces ?? []).find((s) => s.is_active);
  const all = vaults ?? [];
  // The explorer shows one vault: the default, or the most recent.
  const current = all.find((v) => v.is_default) ?? all[0];
  const stats = (current?.stats ?? {}) as Record<string, number>;

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Vault</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {config.chunking.strategy} chunking · {config.chunking.sizeTokens} tokens /{" "}
            {config.chunking.overlapTokens} overlap ·{" "}
            {activeSpace
              ? `${activeSpace.provider}/${activeSpace.model} (${activeSpace.dimensions}d)`
              : "no embedding space"}
          </p>
        </div>
        <UploadMenu hasVault={all.length > 0} />
      </header>

      {all.length === 0 ? (
        <div className="card text-center">
          <p className="font-medium">No vault yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-[var(--color-muted)]">
            Upload a zipped Obsidian vault or pick the folder directly. Markdown notes are
            indexed; attachments are skipped, and notes marked <code>private: true</code> or
            tagged <code>#private</code> are never embedded.
          </p>
        </div>
      ) : (
        <>
          <div className="card mb-3 flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium">
                {current.name as string}
                {current.is_default && (
                  <span className="badge text-[var(--color-muted)]">default</span>
                )}
                <span
                  className={`badge ${
                    current.status === "ready"
                      ? "border-[#1a4d2e] text-[var(--color-ok)]"
                      : current.status === "failed"
                        ? "border-[#5c2229] text-[var(--color-bad)]"
                        : "border-[#5c4a1a] text-[var(--color-warn)]"
                  }`}
                >
                  {current.status as string}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                {stats.notes ?? 0} notes · {stats.chunks ?? 0} chunks ·{" "}
                {(stats.tokens ?? 0).toLocaleString()} tokens
                {stats.private ? ` · ${stats.private} private` : ""}
                {stats.attachments ? ` · ${stats.attachments} attachments skipped` : ""}
              </p>
              {current.error && (
                <p className="mt-1.5 text-xs text-[var(--color-bad)]">{current.error as string}</p>
              )}
            </div>

            <VaultActions
              vaultId={current.id as string}
              hasArchive={Boolean(current.archive_path)}
            />
          </div>

          <VaultExplorer
            vaultId={current.id as string}
            noteCount={(stats.notes as number) ?? 0}
          />

          {all.length > 1 && (
            <section className="mt-8">
              <h2 className="mb-2 text-sm font-medium text-[var(--color-muted)]">Other vaults</h2>
              <div className="card divide-y divide-[var(--color-border-soft)] p-0 text-sm">
                {all
                  .filter((v) => v.id !== current.id)
                  .map((v) => {
                    const s = (v.stats ?? {}) as Record<string, number>;
                    return (
                      <div key={v.id as string} className="flex items-center gap-3 px-5 py-3">
                        <span className="flex-1 truncate">{v.name as string}</span>
                        <span className="text-xs text-[var(--color-muted)]">
                          {s.notes ?? 0} notes
                        </span>
                        <span className="badge text-[var(--color-muted)]">
                          {v.status as string}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </section>
          )}
        </>
      )}

      {(runs ?? []).length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-medium text-[var(--color-muted)]">Recent ingest runs</h2>
          <div className="card divide-y divide-[var(--color-border-soft)] p-0 text-sm">
            {(runs ?? []).map((run) => {
              const s = (run.stats ?? {}) as Record<string, number>;
              return (
                <div key={run.id as string} className="flex items-center gap-3 px-5 py-2.5">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      run.status === "completed"
                        ? "bg-[var(--color-ok)]"
                        : run.status === "failed"
                          ? "bg-[var(--color-bad)]"
                          : "bg-[var(--color-warn)]"
                    }`}
                  />
                  <span className="shrink-0 text-xs text-[var(--color-muted)]">
                    {new Date(run.started_at as string).toLocaleString()}
                  </span>
                  <span className="flex-1 truncate text-xs text-[var(--color-muted)]">
                    {run.status === "failed"
                      ? (run.error as string)
                      : `${s.notesIndexed ?? 0} indexed, ${s.notesSkipped ?? 0} skipped, ${s.chunksCreated ?? 0} chunks`}
                  </span>
                  <span className="badge text-[var(--color-muted)]">{run.trigger as string}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
