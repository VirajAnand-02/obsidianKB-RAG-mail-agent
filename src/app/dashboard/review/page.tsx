import ReviewCard from "@/components/ReviewCard";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getRuntimeConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * The human-review queue.
 *
 * Everything the grounding gate scored in the uncertain band lands here, with
 * the draft, the excerpts it was built from, and the judge's per-claim verdict
 * side by side — a reviewer should be able to decide without opening the vault.
 */
export default async function ReviewPage() {
  const db = supabaseAdmin();
  const config = await getRuntimeConfig();

  const { data: drafts } = await db
    .from("outbound_emails")
    .select("*, inbound_emails(from_email, from_name, subject, question, received_at)")
    .in("status", ["pending_review", "blocked"])
    .order("created_at", { ascending: false })
    .limit(50);

  const pending = (drafts ?? []).filter((d) => d.status === "pending_review");
  const blocked = (drafts ?? []).filter((d) => d.status === "blocked");

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Review queue</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Auto-send at ≥ {config.grounding.autosendThreshold} · review at ≥{" "}
          {config.grounding.reviewThreshold} · blocked below that
        </p>
      </header>

      {pending.length === 0 && blocked.length === 0 && (
        <div className="card text-center">
          <p className="font-medium">Nothing waiting</p>
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">
            Drafts the grounding gate could not fully verify will appear here.
          </p>
        </div>
      )}

      {pending.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-[var(--color-muted)]">
            Awaiting review ({pending.length})
          </h2>
          <div className="space-y-4">
            {pending.map((draft) => (
              <ReviewCard key={draft.id as string} draft={draft} />
            ))}
          </div>
        </section>
      )}

      {blocked.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-medium text-[var(--color-muted)]">
            Blocked ({blocked.length})
          </h2>
          <p className="mb-3 text-xs text-[var(--color-muted)]">
            These were not sent. The sender received a &ldquo;not in the notes&rdquo; reply instead.
          </p>
          <div className="space-y-4">
            {blocked.map((draft) => (
              <ReviewCard key={draft.id as string} draft={draft} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
