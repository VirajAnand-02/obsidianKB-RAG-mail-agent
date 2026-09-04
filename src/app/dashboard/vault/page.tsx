import VaultUpload from "@/components/VaultUpload";
import VaultActions from "@/components/VaultActions";
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

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Vault</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Chunking: {config.chunking.strategy}, {config.chunking.sizeTokens} tokens with{" "}
          {config.chunking.overlapTokens} overlap · Embedding:{" "}
          {activeSpace
            ? `${activeSpace.provider}/${activeSpace.model} (${activeSpace.dimensions}d)`
            : "not initialised"}
        </p>
      </header>

      <VaultUpload />

      {(vaults ?? []).length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-medium text-[var(--color-muted)]">Indexed vaults</h2>
          <div className="space-y-3">
            {(vaults ?? []).map((vault) => {
              const stats = (vault.stats ?? {}) as Record<string, number>;
              return (
                <div key={vault.id as string} className="card">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="flex items-center gap-2 font-medium">
                        {vault.name as string}
                        {vault.is_default && (
                          <span className="badge border-[var(--color-border)] text-[var(--color-muted)]">
                            default
                          </span>
                        )}
                      </p>
                      <p className="mt-1 text-xs text-[var(--color-muted)]">
                        {stats.notes ?? 0} notes · {stats.chunks ?? 0} chunks ·{" "}
                        {(stats.tokens ?? 0).toLocaleString()} tokens embedded
                        {stats.private ? ` · ${stats.private} private (excluded)` : ""}
                        {stats.attachments ? ` · ${stats.attachments} attachments skipped` : ""}
                      </p>
                      {vault.error && (
                        <p className="mt-2 text-xs text-[var(--color-bad)]">{vault.error as string}</p>
                      )}
                    </div>

                    <VaultActions
                      vaultId={vault.id as string}
                      hasArchive={Boolean(vault.archive_path)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {(runs ?? []).length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-medium text-[var(--color-muted)]">Recent ingest runs</h2>
          <div className="card divide-y divide-[var(--color-border)] p-0 text-sm">
            {(runs ?? []).map((run) => {
              const stats = (run.stats ?? {}) as Record<string, number>;
              return (
                <div key={run.id as string} className="flex items-center gap-3 px-5 py-3">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      run.status === "completed"
                        ? "bg-[var(--color-ok)]"
                        : run.status === "failed"
                          ? "bg-[var(--color-bad)]"
                          : "bg-[var(--color-warn)]"
                    }`}
                  />
                  <span className="text-[var(--color-muted)]">
                    {new Date(run.started_at as string).toLocaleString()}
                  </span>
                  <span className="flex-1 truncate text-[var(--color-muted)]">
                    {run.status === "failed"
                      ? (run.error as string)
                      : `${stats.notesIndexed ?? 0} indexed, ${stats.notesSkipped ?? 0} skipped, ${stats.chunksCreated ?? 0} chunks`}
                  </span>
                  <span className="badge border-[var(--color-border)] text-[var(--color-muted)]">
                    {run.trigger as string}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {(spaces ?? []).length > 1 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-medium text-[var(--color-muted)]">Embedding spaces</h2>
          <p className="mb-3 text-xs text-[var(--color-muted)]">
            Vectors from previous models are kept until you drop them, so switching back is a
            re-activation rather than a re-embed.
          </p>
          <div className="card divide-y divide-[var(--color-border)] p-0 text-sm">
            {(spaces ?? []).map((space) => (
              <div key={space.id as string} className="flex items-center gap-3 px-5 py-3">
                <span className="flex-1">
                  {space.provider as string}/{space.model as string}
                  <span className="ml-2 text-xs text-[var(--color-muted)]">
                    {space.dimensions as number}d
                  </span>
                </span>
                {space.is_active && (
                  <span className="badge border-[#1f4d2a] bg-[#12261a] text-[var(--color-ok)]">
                    active
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
