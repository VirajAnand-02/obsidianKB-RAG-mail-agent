import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { appConfig } from "@/lib/app-config";
import { createLogger } from "@/lib/logger";

const log = createLogger("auth");

/**
 * Dashboard authentication: a single admin account configured in `.env`.
 *
 * This is a single-operator tool for one person's notes, so an identity
 * provider would be more moving parts than the problem needs. Credentials come
 * from ADMIN_EMAIL / ADMIN_PASSWORD, and a signed cookie carries the session.
 *
 * The cookie is an HMAC over `{email, exp}` rather than a random token in a
 * table: with one account there is no session list worth keeping, and a signed
 * value needs no database round trip on every request. Rotating AUTH_SECRET
 * invalidates every outstanding session, which is the logout-everywhere lever.
 */

export const SESSION_COOKIE = "obsi_session";

export interface AdminUser {
  id: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Falls back to SETTINGS_ENCRYPTION_KEY so a working deployment does not need a
 * second secret, then to a random per-process value so development still runs
 * with neither set (sessions simply do not survive a restart).
 */
let ephemeralSecret: string | null = null;

function sessionSecret(): string {
  if (env.AUTH_SECRET) return env.AUTH_SECRET;
  if (env.SETTINGS_ENCRYPTION_KEY) return env.SETTINGS_ENCRYPTION_KEY;

  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(32).toString("base64");
    log.warn(
      "Neither AUTH_SECRET nor SETTINGS_ENCRYPTION_KEY is set — signing sessions with a " +
        "random per-process key. Sign-ins will not survive a restart or scale beyond one " +
        "instance. Generate one with: openssl rand -base64 32",
    );
  }
  return ephemeralSecret;
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

/** Constant-time string comparison that does not leak length via early exit. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the timing does not distinguish "wrong length".
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function createSessionToken(email: string): string {
  const expiresAt = Date.now() + appConfig.auth.sessionDays * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ email, exp: expiresAt })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined): AdminUser | null {
  if (!token) return null;

  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  if (!safeEqual(signature, sign(payload))) return null;

  try {
    const { email, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: string;
      exp?: number;
    };

    if (!email || !exp || Date.now() > exp) return null;

    // The signature only proves the cookie was issued by us. If ADMIN_EMAIL has
    // changed since, an old session must stop working.
    if (email.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()) return null;

    return { id: "admin", email };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export function isAuthConfigured(): boolean {
  return Boolean(env.ADMIN_EMAIL && env.ADMIN_PASSWORD);
}

/**
 * Checks a submitted email and password.
 *
 * Both are compared in constant time, and the password is compared even when
 * the email is wrong, so response timing cannot be used to discover whether an
 * address is the configured one.
 */
export function verifyCredentials(email: string, password: string): boolean {
  if (!isAuthConfigured()) return false;

  const emailOk = safeEqual(email.trim().toLowerCase(), env.ADMIN_EMAIL.toLowerCase());
  const passwordOk = safeEqual(password, env.ADMIN_PASSWORD);

  return emailOk && passwordOk;
}

// ---------------------------------------------------------------------------
// Development bypass
// ---------------------------------------------------------------------------

/**
 * Local development skips the login entirely.
 *
 * The guards are deliberately belt-and-braces, because the cost of this leaking
 * into a deployment is an open door to the whole vault:
 *
 *   - `VERCEL` is set on every Vercel build and runtime, so a deployment can
 *     never bypass even if NODE_ENV were wrong. This matters because `.env`
 *     here contains NODE_ENV=development, and copying that file into Vercel's
 *     environment variables is an easy mistake to make.
 *   - `NODE_ENV` must not be production. `next build` and `next start` force it
 *     to production regardless of `.env`.
 *   - `DEV_AUTH_BYPASS=false` opts out, to exercise the real login locally.
 */
/**
 * Public demo mode.
 *
 * Set `DEMO_MODE=true` and the dashboard opens with no login at all, so a
 * recruiter or reviewer can walk through the whole system without credentials.
 *
 * Unlike `DEV_AUTH_BYPASS`, this deliberately *does* apply in production and on
 * Vercel — a demo nobody can reach is not a demo.
 *
 * Access is genuinely complete: uploading and re-indexing vaults, the
 * playground, settings, provider credentials, traces, and approving a draft in
 * the review queue, which sends a real email. Nothing is stubbed or read-only,
 * because a demo that quietly disables the interesting half demonstrates
 * nothing.
 *
 * That makes it the single most dangerous flag in the project. It is off by
 * default, must be set explicitly, is announced in the UI on every page, and
 * logs a warning on first use. Turn it off when the demo window closes.
 */
export function isDemoMode(): boolean {
  const value = (process.env.DEMO_MODE ?? "").trim().toLowerCase();
  return value === "true" || value === "1" || value === "on";
}

/** The identity every visitor is given while the demo is open. */
export function demoUser(): AdminUser {
  return { id: "demo", email: "demo@obsi-relay" };
}

export function isDevAuthBypassEnabled(): boolean {
  if (process.env.VERCEL) return false;
  if (process.env.NODE_ENV === "production") return false;

  const opt = (process.env.DEV_AUTH_BYPASS ?? "").trim().toLowerCase();
  if (opt === "false" || opt === "0" || opt === "off") return false;

  return true;
}

export function devAdminUser(): AdminUser {
  return { id: "dev", email: env.ADMIN_EMAIL || "dev@localhost" };
}

// Warned once per process, so the bypass is visible without flooding the log.
let bypassWarned = false;
let demoWarned = false;

// ---------------------------------------------------------------------------
// Session access
// ---------------------------------------------------------------------------

export async function getAdmin(): Promise<AdminUser | null> {
  // Checked before everything else: in demo mode there is no session to read.
  if (isDemoMode()) {
    if (!demoWarned) {
      demoWarned = true;
      log.warn(
        "DEMO_MODE is on — the dashboard is open to anyone with the URL, with full admin " +
          "access including sending email. Unset DEMO_MODE to require a sign-in.",
      );
    }
    return demoUser();
  }

  if (isDevAuthBypassEnabled()) {
    if (!bypassWarned) {
      bypassWarned = true;
      log.warn(
        "Authentication bypassed for local development — every request is treated as the admin. " +
          "Set DEV_AUTH_BYPASS=false to require a real sign-in.",
      );
    }
    return devAdminUser();
  }

  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

/** Cookie options shared by login and logout so they cannot drift apart. */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    // Secure cookies are dropped over plain http, which would break localhost.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/**
 * Guard for API routes. Returns a 401 response when the caller is not signed in.
 */
export async function requireAdminApi(): Promise<
  { ok: true; user: AdminUser } | { ok: false; response: NextResponse }
> {
  const user = await getAdmin();
  if (user) return { ok: true, user };

  return {
    ok: false,
    response: NextResponse.json(
      { error: "Unauthorised. Sign in at /login." },
      { status: 401 },
    ),
  };
}
