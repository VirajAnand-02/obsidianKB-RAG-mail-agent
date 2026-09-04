"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client, used only for the sign-in flow.
 *
 * Both key names are referenced as literal `process.env.X` expressions rather
 * than looked up dynamically: Next.js inlines `NEXT_PUBLIC_*` values into the
 * client bundle at build time by matching the literal text, so a computed
 * lookup would resolve to undefined in the browser.
 */
export function supabaseBrowser() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Supabase is not configured in the browser bundle. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env, then restart the dev server " +
        "(NEXT_PUBLIC_* values are baked in at build time).",
    );
  }

  return createBrowserClient(url, key);
}
