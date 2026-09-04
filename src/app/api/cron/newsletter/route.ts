import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/auth";
import { getRuntimeConfig } from "@/lib/config";
import { composeNewsletter, sendNewsletterIssue } from "@/lib/agents/newsletter";
import { createLogger, errorMessage } from "@/lib/logger";

const log = createLogger("api:cron:newsletter");

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Scheduled newsletter run. Wired up in vercel.json; the schedule itself lives
 * there, while NEWSLETTER_ENABLED and NEWSLETTER_CRON control whether a firing
 * actually does anything.
 *
 * Composes an issue, runs it through the grounding gate, and either sends it or
 * leaves it in the dashboard for approval depending on
 * NEWSLETTER_REQUIRE_APPROVAL.
 */
async function run() {
  const config = await getRuntimeConfig();

  if (!config.newsletter.enabled) {
    return NextResponse.json({ ok: true, skipped: "Newsletter is disabled in Settings." });
  }

  try {
    const draft = await composeNewsletter();

    if (!draft) {
      return NextResponse.json({
        ok: true,
        skipped: "No notes changed in the lookback window; nothing to send.",
      });
    }

    if (draft.status !== "approved") {
      log.info("Newsletter drafted but held", { issueId: draft.issueId, status: draft.status });
      return NextResponse.json({
        ok: true,
        issueId: draft.issueId,
        status: draft.status,
        reason: draft.rationale,
        message:
          draft.status === "blocked"
            ? "The grounding gate blocked this issue."
            : "Waiting for approval in the dashboard.",
      });
    }

    const result = await sendNewsletterIssue(draft.issueId, "cron");
    return NextResponse.json({ ok: true, issueId: draft.issueId, ...result });
  } catch (e) {
    log.error("Newsletter cron failed", { error: errorMessage(e) });
    return NextResponse.json({ ok: false, error: errorMessage(e) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const auth = verifyCronRequest(request);
  if (!auth.ok) return auth.response;
  return run();
}

/** POST is accepted so the run can be triggered manually with the same secret. */
export async function POST(request: Request) {
  const auth = verifyCronRequest(request);
  if (!auth.ok) return auth.response;
  return run();
}
