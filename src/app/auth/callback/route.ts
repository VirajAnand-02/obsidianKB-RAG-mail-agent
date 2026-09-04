import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { isAdminEmail } from "@/lib/auth";
import { createLogger, errorMessage } from "@/lib/logger";

const log = createLogger("auth:callback");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Magic-link callback.
 *
 * Handles both link formats Supabase can send:
 *  - `?code=` (PKCE), the default for @supabase/ssr
 *  - `?token_hash=&type=` (implicit / older templates)
 *
 * After establishing the session it applies the ADMIN_EMAILS allowlist. A valid
 * Supabase identity is authentication, not authorisation — without this check a
 * public project would let any signup into the vault.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const next = url.searchParams.get("next") ?? "/dashboard";

  // Redirects must be built from the request's own origin, not NEXT_PUBLIC_APP_URL,
  // so preview deployments and custom domains land back on themselves.
  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/login?error=${reason}`, url.origin));

  if (!code && !tokenHash) return fail("missing_code");

  const supabase = await supabaseServer();

  try {
    if (code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);

      if (error || !data.user?.email) {
        log.warn("Code exchange failed", { error: error?.message });
        // The PKCE verifier is a cookie set when the link was requested, so a
        // link opened on a different device or browser cannot complete.
        return fail(error?.message.includes("code verifier") ? "wrong_device" : "invalid_code");
      }

      if (!isAdminEmail(data.user.email)) {
        await supabase.auth.signOut();
        return fail("not_admin");
      }
    } else {
      const { data, error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash!,
        type: type ?? "email",
      });

      if (error || !data.user?.email) {
        log.warn("OTP verification failed", { error: error?.message });
        return fail("invalid_code");
      }

      if (!isAdminEmail(data.user.email)) {
        await supabase.auth.signOut();
        return fail("not_admin");
      }
    }
  } catch (e) {
    log.error("Callback threw", { error: errorMessage(e) });
    return fail("server_error");
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
