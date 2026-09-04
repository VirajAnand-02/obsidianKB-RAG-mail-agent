import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getEnv, supabaseBrowserKey } from "@/lib/env";

/**
 * Request-scoped Supabase client for server components and route handlers.
 * Carries the signed-in admin's session, so it is subject to RLS — unlike
 * `supabaseAdmin()`, which bypasses it.
 */
export async function supabaseServer() {
  const env = getEnv();
  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, supabaseBrowserKey(), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server components cannot set cookies; middleware refreshes the
          // session instead, so this is safe to ignore here.
        }
      },
    },
  });
}
