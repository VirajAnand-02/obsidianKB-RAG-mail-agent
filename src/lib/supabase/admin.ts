import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { appConfig } from "@/lib/app-config";
import { supabaseServerKey } from "@/lib/env";

/**
 * Service-role client. Bypasses RLS, so this must never be imported into
 * anything that ships to the browser. All ingestion, retrieval and email work
 * runs through it.
 */
let cached: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;
  const secretKey = supabaseServerKey();

  if (!appConfig.supabase.url || !secretKey) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY " +
        "(or SUPABASE_SERVICE_ROLE_KEY on older projects) in .env, then run `npm run db:init`.",
    );
  }

  cached = createClient(
    appConfig.supabase.url,
    secretKey,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-application-name": "obsi-relay" } },
    },
  );
  return cached;
}

/** True when the service-role credentials are present. */
export function isDatabaseConfigured(): boolean {
  return Boolean(appConfig.supabase.url && supabaseServerKey());
}
