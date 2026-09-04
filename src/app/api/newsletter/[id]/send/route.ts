import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";
import { sendNewsletterIssue } from "@/lib/agents/newsletter";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { errorMessage } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Approves and sends a drafted newsletter issue. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;

  try {
    const body = (await request.json().catch(() => ({}))) as { bodyMarkdown?: string; title?: string };

    // Let the reviewer's edits win over the drafted text.
    if (body.bodyMarkdown?.trim() || body.title?.trim()) {
      const update: Record<string, string> = {};
      if (body.bodyMarkdown?.trim()) update.body_markdown = body.bodyMarkdown.trim();
      if (body.title?.trim()) update.title = body.title.trim();

      const { error } = await supabaseAdmin()
        .from("newsletter_issues")
        .update(update)
        .eq("id", id);
      if (error) throw new Error(error.message);
    }

    const result = await sendNewsletterIssue(id, auth.user.email);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
