import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { isAdminEmail } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Magic-link callback. Exchanges the one-time code for a session, then applies
 * the ADMIN_EMAILS allowlist — a valid Supabase identity is authentication, not
 * authorisation, and a public project would otherwise let any signup in.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/dashboard";

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", url.origin));
  }

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user?.email) {
    return NextResponse.redirect(new URL("/login?error=invalid_code", url.origin));
  }

  if (!isAdminEmail(data.user.email)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/login?error=not_admin", url.origin));
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
