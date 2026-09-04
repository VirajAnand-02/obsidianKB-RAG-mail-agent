import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";
import { getRuntimeConfig, invalidateConfigCache } from "@/lib/config";
import { availableProviders, invalidateCredentialCache } from "@/lib/ai/registry";
import { KNOWN_EMBEDDING_MODELS } from "@/lib/ai/embeddings";
import { encryptSecret, isEncryptionConfigured } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { SUPPORTED_DIMENSIONS } from "@/lib/env";
import { errorMessage } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Setting key -> category, used for grouping in the settings UI. */
const CATEGORY_BY_PREFIX: Record<string, string> = {
  llm: "llm",
  embedding: "embedding",
  chunking: "chunking",
  retrieval: "retrieval",
  grounding: "grounding",
  newsletter: "newsletter",
  email: "email",
};

export async function GET() {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const db = supabaseAdmin();
  const [config, providers, { data: credentials }] = await Promise.all([
    getRuntimeConfig(),
    availableProviders(),
    db.from("provider_credentials").select("provider, hint, updated_at"),
  ]);

  const { data: spaces } = await db
    .from("embedding_spaces")
    .select("*")
    .order("created_at", { ascending: false });

  return NextResponse.json({
    ok: true,
    config,
    providers,
    credentials: credentials ?? [],
    embeddingModels: KNOWN_EMBEDDING_MODELS,
    embeddingSpaces: spaces ?? [],
    supportedDimensions: SUPPORTED_DIMENSIONS,
    encryptionConfigured: isEncryptionConfigured(),
  });
}

/**
 * Saves settings and/or provider credentials.
 *
 * Changing `embedding.*` does not re-embed anything on its own — the existing
 * vectors stay in their own space until `npm run db:reembed` (or the Vault page
 * button) rebuilds them, so a mis-click cannot destroy a working index.
 */
export async function POST(request: Request) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  try {
    const body = (await request.json()) as {
      settings?: Record<string, unknown>;
      credentials?: Record<string, string>;
    };

    const db = supabaseAdmin();
    const saved: string[] = [];

    for (const [key, value] of Object.entries(body.settings ?? {})) {
      const category = CATEGORY_BY_PREFIX[key.split(".")[0]] ?? "general";
      const { error } = await db.rpc("upsert_setting", {
        p_key: key,
        p_value: value as never,
        p_category: category,
        p_actor: auth.user.email,
      });
      if (error) throw new Error(`Could not save ${key}: ${error.message}`);
      saved.push(key);
    }

    const storedKeys: string[] = [];
    for (const [provider, secret] of Object.entries(body.credentials ?? {})) {
      if (!secret?.trim()) {
        // Empty value clears the stored key and falls back to the environment.
        await db.from("provider_credentials").delete().eq("provider", provider);
        storedKeys.push(`${provider} (cleared)`);
        continue;
      }

      const encrypted = encryptSecret(secret.trim());
      const { error } = await db.from("provider_credentials").upsert(
        {
          provider,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          auth_tag: encrypted.authTag,
          hint: encrypted.hint,
          updated_by: auth.user.email,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "provider" },
      );
      if (error) throw new Error(`Could not store the ${provider} key: ${error.message}`);
      storedKeys.push(provider);
    }

    invalidateConfigCache();
    invalidateCredentialCache();

    return NextResponse.json({ ok: true, saved, credentials: storedKeys });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
