import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { errorMessage } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Flat note list for a vault, used to build the file tree.
 *
 * Bodies are deliberately excluded: a large vault is megabytes of markdown and
 * the tree only needs paths and counts. The body is fetched per note when one
 * is opened.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;

  try {
    const { data, error } = await supabaseAdmin()
      .from("notes")
      .select("id, path, title, word_count, token_count, is_private, note_updated_at, tags")
      .eq("vault_id", id)
      .is("deleted_at", null)
      .order("path");

    if (error) throw new Error(error.message);

    return NextResponse.json({
      ok: true,
      notes: (data ?? []).map((n) => ({
        id: n.id,
        path: n.path,
        title: n.title,
        wordCount: n.word_count,
        isPrivate: n.is_private,
        updatedAt: n.note_updated_at,
        tags: n.tags ?? [],
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
