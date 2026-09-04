import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Clears the session cookie. */
export async function POST() {
  const response = NextResponse.json({ ok: true });
  // maxAge 0 expires it immediately; the other options must match the ones used
  // when setting it, or the browser keeps the original cookie.
  response.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  return response;
}
