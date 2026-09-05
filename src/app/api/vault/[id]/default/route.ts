import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";
import { setDefaultVault } from "@/lib/workspace";
import { errorMessage } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * Promotes a vault to the default — the one used to answer inbound email.
 * Viewing a vault in the explorer does not change this; it is a separate,
 * deliberate action.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;

  try {
    await setDefaultVault(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
