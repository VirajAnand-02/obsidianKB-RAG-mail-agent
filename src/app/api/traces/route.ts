import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";
import { listTraces, traceCounts, type TraceOutcome } from "@/lib/traces";
import { errorMessage } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The trace list as JSON, polled by the index page so mail that arrives while
 * it is open shows up without a reload.
 *
 * Same reasoning as the detail route: the pipeline records every stage in
 * Postgres as it runs, so polling reads the one source of truth rather than
 * introducing a second one to keep in sync.
 *
 * Counts deliberately ignore `q`, matching the server render — the filter chips
 * report how much of the mailbox falls into each outcome, not how much of the
 * current search does.
 */
export async function GET(request: Request) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const outcome = (searchParams.get("outcome") ?? "all") as TraceOutcome | "all";
  const search = searchParams.get("q") ?? "";

  try {
    const [traces, counts] = await Promise.all([listTraces({ outcome, search }), traceCounts()]);
    return NextResponse.json({ ok: true, traces, counts });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
