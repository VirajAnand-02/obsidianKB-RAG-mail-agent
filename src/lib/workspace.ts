import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Workspace and default-vault resolution.
 *
 * The deployment is single-tenant, but everything is keyed by workspace so the
 * jump to multi-tenant is an auth change rather than a schema migration. These
 * helpers are the only place that assumption is encoded.
 */

const DEFAULT_SLUG = "default";
let cachedWorkspaceId: string | null = null;

export async function getWorkspaceId(): Promise<string> {
  if (cachedWorkspaceId) return cachedWorkspaceId;

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("workspaces")
    .select("id")
    .eq("slug", DEFAULT_SLUG)
    .maybeSingle();

  if (error) throw new Error(`Could not read workspace: ${error.message}`);

  if (data) {
    cachedWorkspaceId = data.id as string;
    return cachedWorkspaceId;
  }

  const { data: created, error: createError } = await db
    .from("workspaces")
    .insert({ name: "Default", slug: DEFAULT_SLUG })
    .select("id")
    .single();

  if (createError) throw new Error(`Could not create workspace: ${createError.message}`);

  cachedWorkspaceId = created.id as string;
  return cachedWorkspaceId;
}

/** The vault used to answer email, unless a request names another. */
export async function getDefaultVaultId(): Promise<string | null> {
  const db = supabaseAdmin();
  const workspaceId = await getWorkspaceId();

  const { data } = await db
    .from("vaults")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("is_default", true)
    .maybeSingle();

  if (data) return data.id as string;

  // No explicit default: fall back to the most recently ingested ready vault.
  const { data: fallback } = await db
    .from("vaults")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("status", "ready")
    .order("last_ingested_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  return (fallback?.id as string) ?? null;
}

export async function requireDefaultVaultId(): Promise<string> {
  const id = await getDefaultVaultId();
  if (!id) {
    throw new Error(
      "No vault has been ingested yet. Upload an Obsidian vault from the dashboard " +
        "(Vault -> Upload) or run `npm run vault:ingest -- <path>`.",
    );
  }
  return id;
}

/** Promotes one vault to the default, demoting the current one. */
export async function setDefaultVault(vaultId: string): Promise<void> {
  const db = supabaseAdmin();
  const workspaceId = await getWorkspaceId();

  // The partial unique index allows only one default per workspace, so the
  // demotion has to land before the promotion.
  await db
    .from("vaults")
    .update({ is_default: false })
    .eq("workspace_id", workspaceId)
    .eq("is_default", true);

  const { error } = await db.from("vaults").update({ is_default: true }).eq("id", vaultId);
  if (error) throw new Error(`Could not set default vault: ${error.message}`);
}
