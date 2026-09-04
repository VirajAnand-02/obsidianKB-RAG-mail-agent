import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";
import { composeNewsletter } from "@/lib/agents/newsletter";
import { errorMessage } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Drafts a newsletter issue on demand.
 *
 * Same code path as the cron run, so what an admin previews here is what the
 * schedule would produce.
 */
export async function POST(request: Request) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  try {
    const body = (await request.json().catch(() => ({}))) as {
      lookbackDays?: number;
      maxItems?: number;
      vaultId?: string;
    };

    const draft = await composeNewsletter(body);

    if (!draft) {
      return NextResponse.json({
        ok: true,
        skipped: "No notes changed in the lookback window; nothing to draft.",
      });
    }

    return NextResponse.json({ ok: true, ...draft });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
