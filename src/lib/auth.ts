import { NextResponse } from "next/server";
import { env, supabaseBrowserKey } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { createLogger } from "@/lib/logger";

const log = createLogger("auth");

/**
 * Dashboard authentication.
 *
 * Supabase Auth handles identity; ADMIN_EMAILS decides authorisation. Anyone can
 * request a magic link, but only allowlisted addresses get past this check —
 * without it, a public Supabase project would let any signup read the vault.
 */

export interface AdminUser {
  id: string;
  email: string;
}

export async function getCurrentUser(): Promise<AdminUser | null> {
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !supabaseBrowserKey()) return null;

  try {
    const supabase = await supabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user?.email) return null;
    return { id: user.id, email: user.email };
  } catch {
    return null;
  }
}

export function isAdminEmail(email: string): boolean {
  const allowlist = env.ADMIN_EMAILS.map((e) => e.toLowerCase());
  // An empty allowlist locks everyone out rather than letting everyone in.
  if (allowlist.length === 0) return false;
  return allowlist.includes(email.toLowerCase());
}

export async function getAdmin(): Promise<AdminUser | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  if (!isAdminEmail(user.email)) {
    log.warn("Non-admin sign-in attempt", { email: user.email });
    return null;
  }
  return user;
}

/**
 * Guard for API routes. Returns a 401 response when the caller is not an
 * allowlisted admin, otherwise the user.
 */
export async function requireAdminApi(): Promise<
  { ok: true; user: AdminUser } | { ok: false; response: NextResponse }
> {
  const user = await getAdmin();
  if (user) return { ok: true, user };

  return {
    ok: false,
    response: NextResponse.json(
      { error: "Unauthorised. Sign in with an address listed in ADMIN_EMAILS." },
      { status: 401 },
    ),
  };
}

/**
 * Guard for cron endpoints, which run without a user session.
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
 */
export function verifyCronRequest(request: Request): { ok: true } | { ok: false; response: NextResponse } {
  const secret = env.CRON_SECRET;

  if (!secret) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "CRON_SECRET is not configured; scheduled endpoints are disabled." },
        { status: 503 },
      ),
    };
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.replace(/^Bearer\s+/i, "");

  if (provided !== secret) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }) };
  }
  return { ok: true };
}
