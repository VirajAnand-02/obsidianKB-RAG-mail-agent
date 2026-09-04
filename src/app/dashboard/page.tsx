import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getRuntimeConfig } from "@/lib/config";
import { errorMessage } from "@/lib/logger";

export const dynamic = "force-dynamic";

async function loadOverview() {
  const db = supabaseAdmin();

  const [notes, chunks, vaults, pending, sent, recentQueries] = await Promise.all([
    db.from("notes").select("id", { count: "exact", head: true }).is("deleted_at", null),
    db.from("chunks").select("id", { count: "exact", head: true }),
    db.from("vaults").select("*").order("created_at", { ascending: false }),
    db
      .from("outbound_emails")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending_review"),
    db.from("outbound_emails").select("id", { count: "exact", head: true }).eq("status", "sent"),
    db
      .from("query_logs")
      .select("id, question, source, created_at, latency_ms")
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  return {
    notes: notes.count ?? 0,
    chunks: chunks.count ?? 0,
    vaults: vaults.data ?? [],
    pendingReview: pending.count ?? 0,
    sent: sent.count ?? 0,
    recentQueries: recentQueries.data ?? [],
  };
}

function Stat({ label, value, href }: { label: string; value: string | number; href?: string }) {
  const content = (
    <div className="card transition-colors hover:border-[#3a4150]">
      <p className="text-xs text-[var(--color-muted)]">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}

export default async function OverviewPage() {
  let data;
  try {
    data = await loadOverview();
  } catch (e) {
    return (
      <div className="card border-[#5c2a2a]">
        <h1 className="font-medium text-[var(--color-bad)]">Could not read the database</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">{errorMessage(e)}</p>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          If the tables do not exist yet, run{" "}
          <code className="text-[var(--color-ink)]">npm run db:init</code>.
        </p>
      </div>
    );
  }

  const config = await getRuntimeConfig();

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {config.llm.provider}/{config.llm.model} · {config.embedding.provider}/
          {config.embedding.model} ({config.embedding.dimensions}d)
          {config.email.dryRun && " · dry-run"}
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Notes indexed" value={data.notes} href="/dashboard/vault" />
        <Stat label="Chunks" value={data.chunks} href="/dashboard/vault" />
        <Stat label="Awaiting review" value={data.pendingReview} href="/dashboard/review" />
        <Stat label="Replies sent" value={data.sent} />
      </div>

      {data.vaults.length === 0 && (
        <div className="card mt-6 border-[var(--color-accent)]/40">
          <h2 className="font-medium">No vault yet</h2>
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">
            Upload a zipped Obsidian vault to build the knowledge base.
          </p>
          <Link href="/dashboard/vault" className="btn-primary mt-4">
            Upload a vault
          </Link>
        </div>
      )}

      {data.vaults.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-medium text-[var(--color-muted)]">Vaults</h2>
          <div className="space-y-2">
            {data.vaults.map((vault) => {
              const stats = (vault.stats ?? {}) as Record<string, number>;
              return (
                <div
                  key={vault.id as string}
                  className="card flex items-center justify-between py-3.5"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      {vault.name as string}
                      {vault.is_default && (
                        <span className="badge border-[var(--color-border)] text-[var(--color-muted)]">
                          default
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                      {stats.notes ?? 0} notes · {stats.chunks ?? 0} chunks
                      {vault.last_ingested_at
                        ? ` · indexed ${new Date(vault.last_ingested_at as string).toLocaleDateString()}`
                        : ""}
                    </p>
                  </div>
                  <StatusBadge status={vault.status as string} />
                </div>
              );
            })}
          </div>
        </section>
      )}

      {data.recentQueries.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-medium text-[var(--color-muted)]">Recent questions</h2>
          <div className="card divide-y divide-[var(--color-border)] p-0">
            {data.recentQueries.map((q) => (
              <div key={q.id as string} className="flex items-center gap-3 px-5 py-3">
                <span className="badge border-[var(--color-border)] text-[var(--color-muted)]">
                  {q.source as string}
                </span>
                <p className="min-w-0 flex-1 truncate text-sm">{q.question as string}</p>
                <span className="shrink-0 text-xs tabular-nums text-[var(--color-muted)]">
                  {q.latency_ms ? `${Math.round((q.latency_ms as number) / 100) / 10}s` : ""}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ready: "border-[#1f4d2a] bg-[#12261a] text-[var(--color-ok)]",
    ingesting: "border-[#5c4a1a] bg-[#241f10] text-[var(--color-warn)]",
    uploading: "border-[#5c4a1a] bg-[#241f10] text-[var(--color-warn)]",
    failed: "border-[#5c2a2a] bg-[#2a1516] text-[var(--color-bad)]",
  };
  return (
    <span className={`badge shrink-0 ${styles[status] ?? "border-[var(--color-border)] text-[var(--color-muted)]"}`}>
      {status}
    </span>
  );
}
