import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { requireAdminApi } from "@/lib/auth";
import { ingestZip, ingestFiles } from "@/lib/vault/ingest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getWorkspaceId, setDefaultVault } from "@/lib/workspace";
import { createLogger, errorMessage } from "@/lib/logger";

const log = createLogger("api:vault:upload");

export const runtime = "nodejs";
// Ingesting a large vault means many embedding calls.
export const maxDuration = 300;

/**
 * Vault upload.
 *
 * Accepts either a zipped vault (`file`) or a browser directory selection
 * (`files[]` with `paths[]` carrying the relative paths, since a File's own
 * name loses the directory structure).
 *
 * The archive is copied to Supabase Storage before indexing so a vault can be
 * re-ingested after a chunking or embedding change without re-uploading.
 */
export async function POST(request: Request) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const db = supabaseAdmin();
  const workspaceId = await getWorkspaceId();

  let form: FormData;
  try {
    form = await request.formData();
  } catch (e) {
    return NextResponse.json(
      { error: `Could not read the upload: ${errorMessage(e)}` },
      { status: 400 },
    );
  }

  const name = (form.get("name") as string)?.trim() || "My Vault";
  const description = ((form.get("description") as string) ?? "").trim() || null;
  const makeDefault = form.get("makeDefault") !== "false";
  const zip = form.get("file") as File | null;
  const directoryFiles = form.getAll("files") as File[];

  if (!zip && directoryFiles.length === 0) {
    return NextResponse.json(
      { error: "No vault provided. Attach a .zip as `file`, or a folder as `files`." },
      { status: 400 },
    );
  }

  const maxBytes = env.MAX_VAULT_UPLOAD_MB * 1024 * 1024;
  if (zip && zip.size > maxBytes) {
    return NextResponse.json(
      {
        error: `Archive is ${(zip.size / 1024 / 1024).toFixed(1)} MB, over the ${env.MAX_VAULT_UPLOAD_MB} MB limit.`,
      },
      { status: 413 },
    );
  }

  const { data: vault, error: vaultError } = await db
    .from("vaults")
    .insert({
      workspace_id: workspaceId,
      name,
      description,
      source: zip ? "zip" : "folder",
      status: "uploading",
      archive_bytes: zip?.size ?? null,
    })
    .select("id")
    .single();

  if (vaultError) {
    return NextResponse.json(
      { error: `Could not create the vault: ${vaultError.message}` },
      { status: 500 },
    );
  }

  const vaultId = vault.id as string;

  try {
    if (zip) {
      const buffer = new Uint8Array(await zip.arrayBuffer());

      // Store the archive first: if indexing fails, the upload is not lost and
      // the user can retry from the dashboard instead of re-uploading.
      const objectPath = `${workspaceId}/${vaultId}/${Date.now()}-${zip.name}`;
      const { error: uploadError } = await db.storage
        .from(env.SUPABASE_STORAGE_BUCKET)
        .upload(objectPath, buffer, {
          contentType: "application/zip",
          upsert: true,
        });

      if (uploadError) {
        log.warn("Could not archive the upload to storage; indexing anyway", {
          error: uploadError.message,
        });
      } else {
        await db.from("vaults").update({ archive_path: objectPath }).eq("id", vaultId);
      }

      const result = await ingestZip(buffer, { vaultId, trigger: "upload" });
      if (makeDefault) await setDefaultVault(vaultId);

      return NextResponse.json({ ok: true, ...result });
    }

    // Directory upload: paths[] is positional with files[].
    const paths = form.getAll("paths") as string[];
    const entries = await Promise.all(
      directoryFiles.map(async (file, i) => ({
        path: paths[i] ?? file.name,
        content: await file.text(),
        bytes: file.size,
      })),
    );

    const result = await ingestFiles(entries, { vaultId, trigger: "upload" });
    if (makeDefault) await setDefaultVault(vaultId);

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const error = errorMessage(e);
    log.error("Vault upload failed", { vaultId, error });
    await db.from("vaults").update({ status: "failed", error }).eq("id", vaultId);
    return NextResponse.json({ error, vaultId }, { status: 500 });
  }
}
