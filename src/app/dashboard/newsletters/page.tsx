import NewsletterActions from "@/components/NewsletterActions";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getRuntimeConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function NewslettersPage() {
  const db = supabaseAdmin();
  const config = await getRuntimeConfig();

  const [{ data: issues }, { count: subscribers }] = await Promise.all([
    db.from("newsletter_issues").select("*").order("created_at", { ascending: false }).limit(20),
    db
      .from("newsletter_subscribers")
      .select("id", { count: "exact", head: true })
      .eq("status", "active"),
  ]);

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Newsletters</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {config.newsletter.enabled
              ? `Scheduled ${config.newsletter.cron} (${config.newsletter.timezone}) · ${config.newsletter.lookbackDays}-day lookback`
              : "Disabled — enable it in Settings or set NEWSLETTER_ENABLED=true"}{" "}
            · {subscribers ?? 0} active subscribers
          </p>
        </div>
        <NewsletterActions />
      </header>

      {(issues ?? []).length === 0 ? (
        <div className="card text-center">
          <p className="font-medium">No issues yet</p>
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">
            Draft one now, or wait for the schedule. Issues are composed from notes changed in the
            lookback window and pass through the same grounding gate as replies.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {(issues ?? []).map((issue) => {
            const sources = (issue.source_notes ?? []) as { title: string }[];
            const grounding = (issue.grounding ?? {}) as { rationale?: string };

            return (
              <div key={issue.id as string} className="card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{issue.title as string}</p>
                    <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                      {new Date(issue.created_at as string).toLocaleString()} · {sources.length}{" "}
                      source notes
                      {issue.recipient_count
                        ? ` · sent to ${issue.recipient_count as number}`
                        : ""}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={`badge ${
                        issue.status === "sent"
                          ? "border-[#1f4d2a] bg-[#12261a] text-[var(--color-ok)]"
                          : issue.status === "blocked"
                            ? "border-[#5c2a2a] bg-[#2a1516] text-[var(--color-bad)]"
                            : "border-[#5c4a1a] bg-[#241f10] text-[var(--color-warn)]"
                      }`}
                    >
                      {issue.status as string}
                      {issue.grounding_score !== null
                        ? ` · ${(issue.grounding_score as number).toFixed(2)}`
                        : ""}
                    </span>

                    {issue.status === "pending_review" && (
                      <NewsletterActions issueId={issue.id as string} mode="send" />
                    )}
                  </div>
                </div>

                <div className="mt-3 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--color-canvas)] p-3.5 text-sm leading-relaxed">
                  {issue.body_markdown as string}
                </div>

                {grounding.rationale && (
                  <p className="mt-2 text-xs text-[var(--color-muted)]">{grounding.rationale}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
