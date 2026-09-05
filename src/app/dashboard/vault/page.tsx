import UploadMenu from "@/components/UploadMenu";
import VaultSwitcher from "@/components/VaultSwitcher";
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
        <div className="card animate-rise-in text-center">
          <p className="font-medium">No vault yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-[var(--color-muted)]">
            Upload a zipped Obsidian vault or pick the folder directly. Markdown notes are
            indexed; attachments are skipped, and notes marked <code>private: true</code> or
            tagged <code>#private</code> are never embedded.
          </p>
        </div>
      ) : (
        <VaultSwitcher
          vaults={all.map((v) => ({
            id: v.id as string,
            name: v.name as string,
            status: v.status as string,
            isDefault: Boolean(v.is_default),
            hasArchive: Boolean(v.archive_path),
            error: (v.error as string) ?? null,
            stats: (v.stats ?? {}) as Record<string, number>,
          }))}
        />
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
