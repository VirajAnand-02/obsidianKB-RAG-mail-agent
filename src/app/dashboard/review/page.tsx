import ReviewQueue, { type ReviewDraft } from "@/components/ReviewQueue";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getRuntimeConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * The human-review queue.
 *
 * Everything the grounding gate scored in the uncertain band lands here, plus
 * anything it blocked outright — a blocked draft is worth seeing, because a
 * queue that hides its refusals hides its mistakes too.
 */
export default async function ReviewPage() {
  const db = supabaseAdmin();
  const config = await getRuntimeConfig();

  const { data } = await db
    .from("outbound_emails")
    .select("*, inbound_emails(id, question, received_at)")
    .in("status", ["pending_review", "blocked"])
    .order("created_at", { ascending: false })
    .limit(100);

  const rows = (data ?? []) as unknown as Record<string, unknown>[];

  const drafts: ReviewDraft[] = rows.map((row) => {
    const inbound = (Array.isArray(row.inbound_emails)
      ? row.inbound_emails[0]
      : row.inbound_emails) as Record<string, unknown> | undefined;

    return {
      id: row.id as string,
      subject: (row.subject as string) ?? "(no subject)",
      toEmail: row.to_email as string,
      bodyMarkdown: (row.body_markdown as string) ?? "",
      editedBodyMarkdown: (row.edited_body_markdown as string) ?? null,
      status: row.status as string,
      groundingScore: (row.grounding_score as number) ?? null,
      grounding: (row.grounding ?? {}) as ReviewDraft["grounding"],
      retrieval: (row.retrieval ?? []) as ReviewDraft["retrieval"],
      question: (inbound?.question as string) ?? null,
      receivedAt: (inbound?.received_at as string) ?? null,
      inboundId: (inbound?.id as string) ?? null,
    };
  });

  const pending = drafts.filter((d) => d.status === "pending_review").length;
  const blocked = drafts.length - pending;

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Review queue</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Auto-send at ≥ {config.grounding.autosendThreshold} · review at ≥{" "}
          {config.grounding.reviewThreshold} · blocked below that
          {drafts.length > 0 && ` · ${pending} waiting, ${blocked} blocked`}
        </p>
      </header>

      <ReviewQueue drafts={drafts} />
    </div>
  );
}
