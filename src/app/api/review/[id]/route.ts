import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";
import { sendApprovedDraft } from "@/lib/agents/pipeline";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { errorMessage } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Review queue actions: approve (send), reject, or edit a drafted reply that
 * the grounding gate held back.
 *
 * Every action is written to `review_actions` as well as updating the draft, so
 * the decision history survives later edits to the draft itself.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const db = supabaseAdmin();

  try {
    const body = (await request.json()) as {
      action?: "approve" | "reject" | "edit";
      note?: string;
      bodyMarkdown?: string;
    };

    const { data: draft, error } = await db
      .from("outbound_emails")
      .select("id, status")
      .eq("id", id)
      .single();

    if (error || !draft) {
      return NextResponse.json({ error: "Draft not found." }, { status: 404 });
    }
    if (draft.status === "sent") {
      return NextResponse.json({ error: "This draft has already been sent." }, { status: 409 });
    }

    switch (body.action) {
      case "edit": {
        if (!body.bodyMarkdown?.trim()) {
          return NextResponse.json({ error: "bodyMarkdown is required to edit." }, { status: 400 });
        }

        // The original draft is kept: comparing what the model wrote against
        // what a human sent is the most useful signal for improving the prompt.
        await db
          .from("outbound_emails")
          .update({ edited_body_markdown: body.bodyMarkdown, review_note: body.note ?? null })
          .eq("id", id);

        await db.from("review_actions").insert({
          outbound_id: id,
          action: "edit",
          actor: auth.user.email,
          note: body.note ?? null,
        });

        return NextResponse.json({ ok: true, action: "edit" });
      }

      case "approve": {
        const result = await sendApprovedDraft(id, auth.user.email);
        return NextResponse.json({ ok: true, action: "approve", ...result });
      }

      case "reject": {
        await db
          .from("outbound_emails")
          .update({
            status: "rejected",
            reviewed_by: auth.user.email,
            reviewed_at: new Date().toISOString(),
            review_note: body.note ?? null,
          })
          .eq("id", id);

        await db.from("review_actions").insert({
          outbound_id: id,
          action: "reject",
          actor: auth.user.email,
          note: body.note ?? null,
        });

        return NextResponse.json({ ok: true, action: "reject" });
      }

      default:
        return NextResponse.json(
          { error: "action must be one of: approve, reject, edit." },
          { status: 400 },
        );
    }
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}

/** Full draft detail for the reviewer, including retrieval and judge output. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;

  const { data, error } = await supabaseAdmin()
    .from("outbound_emails")
    .select("*, inbound_emails(*), review_actions(*)")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  return NextResponse.json({ ok: true, draft: data });
}
