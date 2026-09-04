import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { errorMessage } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * One-click unsubscribe.
 *
 * Handles both the link in the footer (GET) and the `List-Unsubscribe-Post`
 * header that Gmail and Outlook use (POST). Gmail requires a working one-click
 * unsubscribe for bulk senders, and honouring it is what keeps the sending
 * domain out of spam folders.
 */
async function unsubscribe(token: string) {
  const { data, error } = await supabaseAdmin().rpc("unsubscribe_by_token", { p_token: token });
  if (error) throw new Error(error.message);
  return Boolean(data);
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Missing token." }, { status: 400 });

  try {
    const changed = await unsubscribe(token);
    return NextResponse.json({
      ok: true,
      message: changed ? "You have been unsubscribed." : "You were already unsubscribed.",
    });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  let token = url.searchParams.get("token");

  if (!token) {
    const body = await request.text();
    token = new URLSearchParams(body).get("token");
  }
  if (!token) return NextResponse.json({ error: "Missing token." }, { status: 400 });

  try {
    await unsubscribe(token);
    // One-click unsubscribe expects a bare 200.
    return new NextResponse(null, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
