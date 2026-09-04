"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

/** Callback failures arrive as ?error=<reason>; explain each in plain terms. */
const ERROR_MESSAGES: Record<string, string> = {
  missing_code: "That sign-in link was incomplete. Request a new one below.",
  invalid_code: "That sign-in link has expired or was already used. Request a new one.",
  wrong_device:
    "Sign-in links must be opened in the same browser that requested them. Request a new link and open it here.",
  not_admin: "That address is not in the admin allowlist (ADMIN_EMAILS).",
  server_error: "Something went wrong completing sign-in. Please try again.",
};

/**
 * Magic-link sign-in.
 *
 * Anyone can request a link; only addresses in ADMIN_EMAILS get past the
 * server-side guard afterwards. Nothing here reveals whether an address is on
 * the allowlist, so this page cannot be used to enumerate admins.
 */
export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const params = useSearchParams();
  const callbackError = params.get("error");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setMessage("");

    try {
      const supabase = supabaseBrowser();
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });

      if (error) throw error;
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Could not send the sign-in link.");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <Link href="/" className="mb-8 text-sm text-[var(--color-muted)] hover:text-[var(--color-ink)]">
        ← Obsi-Relay
      </Link>

      <div className="card">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">
          We will email you a sign-in link.
        </p>

        {status === "sent" ? (
          <div className="mt-6 rounded-lg border border-[#1f4d2a] bg-[#12261a] p-4 text-sm">
            <p className="font-medium text-[var(--color-ok)]">Check your inbox</p>
            <p className="mt-1 text-[var(--color-muted)]">
              If {email} is on the admin allowlist, a sign-in link is on its way.
            </p>
          </div>
        ) : (
          <form onSubmit={signIn} className="mt-6">
            <label className="label" htmlFor="email">
              Email address
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@yourdomain.com"
              className="input"
            />

            {(status === "error" || callbackError) && (
              <p className="mt-3 text-sm text-[var(--color-bad)]">
                {message ||
                  ERROR_MESSAGES[callbackError ?? ""] ||
                  "Sign-in failed. Please try again."}
              </p>
            )}

            <button
              type="submit"
              disabled={status === "sending" || !email.trim()}
              className="btn-primary mt-4 w-full"
            >
              {status === "sending" ? "Sending…" : "Send sign-in link"}
            </button>
          </form>
        )}
      </div>

      <p className="mt-4 text-center text-xs text-[var(--color-muted)]">
        Access is limited to addresses listed in <code>ADMIN_EMAILS</code>.
      </p>
    </main>
  );
}
