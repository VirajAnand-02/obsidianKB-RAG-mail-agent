import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";
import { getTrace } from "@/lib/traces";
import { errorMessage } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One trace as JSON, polled by the detail view while a pipeline is still
 * running. Polling rather than streaming: the pipeline writes its stages to
 * Postgres as it goes, so the database is already the source of truth and a
 * socket would only add a second one to keep in sync.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;

  try {
    const trace = await getTrace(id);
    if (!trace) return NextResponse.json({ error: "Trace not found." }, { status: 404 });
    return NextResponse.json({ ok: true, trace });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
