import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { appConfig } from "@/lib/app-config";
import {
  SESSION_COOKIE,
  createSessionToken,
  isAuthConfigured,
  sessionCookieOptions,
  verifyCredentials,
} from "@/lib/auth";
import { createLogger } from "@/lib/logger";

const log = createLogger("api:auth:login");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Password sign-in.
 *
 * A single admin account means there is no user enumeration surface, but there
 * is a brute-force one: one address, one password, and an endpoint anyone can
 * reach. Failed attempts are therefore throttled per IP with a growing delay.
 */

const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

// In-memory, so it resets on redeploy and is per-instance. Adequate for a
// single-operator tool; a shared store would be the upgrade if this ever runs
// as more than one instance.
const attempts = new Map<string, { count: number; firstAt: number }>();

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
}

function tooManyAttempts(key: string): boolean {
  const record = attempts.get(key);
  if (!record) return false;

  if (Date.now() - record.firstAt > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordFailure(key: string) {
  const record = attempts.get(key);
  if (!record || Date.now() - record.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  record.count++;
}

export async function POST(request: Request) {
  if (!isAuthConfigured()) {
    return NextResponse.json(
      {
        error:
          "Sign-in is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env, then restart.",
      },
      { status: 503 },
    );
  }

  const key = clientKey(request);
  if (tooManyAttempts(key)) {
    log.warn("Login rate limit hit", { key });
    return NextResponse.json(
      { error: "Too many failed attempts. Try again in a few minutes." },
      { status: 429 },
    );
  }

  let email = "";
  let password = "";
  try {
    const body = (await request.json()) as { email?: string; password?: string };
    email = body.email ?? "";
    password = body.password ?? "";
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!email.trim() || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  if (!verifyCredentials(email, password)) {
    recordFailure(key);
    // Deliberately vague: never reveal which of the two was wrong.
    log.warn("Failed sign-in attempt", { key });
    return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });
  }

  attempts.delete(key);

  const response = NextResponse.json({ ok: true, email: env.ADMIN_EMAIL });
  response.cookies.set(
    SESSION_COOKIE,
    createSessionToken(env.ADMIN_EMAIL),
    sessionCookieOptions(appConfig.auth.sessionDays * 24 * 60 * 60),
  );

  log.info("Signed in", { email: env.ADMIN_EMAIL });
  return response;
}
