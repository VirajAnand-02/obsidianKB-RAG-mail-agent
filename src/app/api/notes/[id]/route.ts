import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { errorMessage } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One note, with its body and the chunks retrieval would draw from.
 *
 * Showing the chunk boundaries next to the text is the point: when an answer
 * quotes something odd, the usual cause is a chunk that split badly, and that
 * is invisible from the note alone.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const db = supabaseAdmin();

  try {
    const { data: note, error } = await db
      .from("notes")
      .select("id, path, title, body, frontmatter, tags, links, aliases, word_count, is_private, note_updated_at")
      .eq("id", id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });

    const { data: chunks } = await db
      .from("chunks")
      .select("id, ordinal, heading_path, token_count, char_start, char_end")
      .eq("note_id", id)
      .order("ordinal");

    return NextResponse.json({
      ok: true,
      note: {
        id: note.id,
        path: note.path,
        title: note.title,
        body: note.body,
        frontmatter: note.frontmatter ?? {},
        tags: note.tags ?? [],
        links: note.links ?? [],
        aliases: note.aliases ?? [],
        wordCount: note.word_count,
        isPrivate: note.is_private,
        updatedAt: note.note_updated_at,
      },
      chunks: (chunks ?? []).map((c) => ({
        id: c.id,
        ordinal: c.ordinal,
        headingPath: c.heading_path ?? [],
        tokenCount: c.token_count,
        charStart: c.char_start,
        charEnd: c.char_end,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
