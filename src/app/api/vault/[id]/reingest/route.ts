import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";
import { reingestFromStorage } from "@/lib/vault/ingest";
import { reembedVault } from "@/lib/rag/indexer";
import { errorMessage } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Rebuilds a vault's index from the stored archive.
 *
 * Two modes:
 *  - `mode: "reembed"` keeps the existing chunks and only regenerates vectors.
 *    This is what you run after switching embedding model.
 *  - `mode: "full"` re-extracts and re-chunks from the archive. Needed after a
 *    chunking parameter change, since chunk boundaries themselves move.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;

  try {
    const body = (await request.json().catch(() => ({}))) as {
      mode?: "full" | "reembed";
      force?: boolean;
    };

    if (body.mode === "reembed") {
      const result = await reembedVault(id);
      return NextResponse.json({ ok: true, mode: "reembed", ...result });
    }

    const result = await reingestFromStorage({
      vaultId: id,
      trigger: "manual",
      // A full re-ingest after a chunking change must ignore content hashes,
      // otherwise every unchanged note is skipped and nothing is re-chunked.
      force: body.force ?? true,
    });

    return NextResponse.json({ ok: true, mode: "full", ...result });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
