import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";
import { appConfig } from "@/lib/app-config";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getDefaultVaultId, setDefaultVault } from "@/lib/workspace";
import { createLogger, errorMessage } from "@/lib/logger";

const log = createLogger("api:vault:delete");

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Deletes a vault and everything derived from it.
 *
 * Foreign keys do most of the work: `notes`, `chunks`, the `embeddings_*`
 * tables and `ingest_runs` all cascade. `outbound_emails`, `query_logs` and
 * `eval_runs` are `on delete set null`, so the history of what the system
 * actually said to people survives the deletion of the vault it said it from.
 * That asymmetry is deliberate — losing an audit trail because the source was
 * re-uploaded would be worse than an orphaned reference.
 *
 * Storage is not covered by foreign keys, so the uploaded archives are removed
 * explicitly. A failure there is logged but does not abort: an orphaned zip
 * costs a little space, whereas a half-deleted vault is a confusing state.
 */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const db = supabaseAdmin();

  try {
    const { data: vault, error } = await db
      .from("vaults")
      .select("id, name, workspace_id, is_default, archive_path")
      .eq("id", id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!vault) return NextResponse.json({ error: "Vault not found." }, { status: 404 });

    // Counted before the delete so the confirmation can say what went.
    const [{ count: notes }, { count: chunks }] = await Promise.all([
      db.from("notes").select("id", { count: "exact", head: true }).eq("vault_id", id),
      db.from("chunks").select("id", { count: "exact", head: true }).eq("vault_id", id),
    ]);

    // Remove every archive under this vault's prefix, not just the last one:
    // re-uploads leave earlier zips behind.
    const prefix = `${vault.workspace_id}/${id}`;
    try {
      const { data: files } = await db.storage
        .from(appConfig.supabase.storageBucket)
        .list(prefix);

      const paths = (files ?? []).map((f) => `${prefix}/${f.name}`);
      if (paths.length > 0) {
        await db.storage.from(appConfig.supabase.storageBucket).remove(paths);
      }
    } catch (e) {
      log.warn("Could not remove stored archives; deleting the vault anyway", {
        vaultId: id,
        error: errorMessage(e),
      });
    }

    const { error: deleteError } = await db.from("vaults").delete().eq("id", id);
    if (deleteError) throw new Error(deleteError.message);

    // Inbound email answers from the default vault. If that was the one just
    // removed, promote another so the pipeline keeps working unattended.
    let promoted: string | null = null;
    if (vault.is_default) {
      const next = await getDefaultVaultId();
      if (next) {
        await setDefaultVault(next);
        const { data: row } = await db.from("vaults").select("name").eq("id", next).maybeSingle();
        promoted = (row?.name as string) ?? next;
      }
    }

    log.info("Vault deleted", { vaultId: id, name: vault.name, notes, chunks, promoted });

    return NextResponse.json({
      ok: true,
      name: vault.name,
      notes: notes ?? 0,
      chunks: chunks ?? 0,
      promoted,
    });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
