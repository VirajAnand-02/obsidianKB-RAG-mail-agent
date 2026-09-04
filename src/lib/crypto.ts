import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

/**
 * AES-256-GCM for provider API keys that admins paste into the dashboard.
 *
 * Keys entered in the UI are stored encrypted so a leaked database dump does not
 * hand over the LLM and Resend accounts too. The encryption key itself lives
 * only in the environment (SETTINGS_ENCRYPTION_KEY).
 */

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const raw = env.SETTINGS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "SETTINGS_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` " +
        "and add it to .env before storing provider keys in the dashboard.",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `SETTINGS_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${buf.length}). ` +
        "Generate one with `openssl rand -base64 32`.",
    );
  }
  return buf;
}

export interface Encrypted {
  ciphertext: string;
  iv: string;
  authTag: string;
  /** Last 4 characters, for display without decrypting. */
  hint: string;
}

export function encryptSecret(plaintext: string): Encrypted {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    hint: plaintext.slice(-4),
  };
}

export function decryptSecret(enc: Omit<Encrypted, "hint">): string {
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(enc.iv, "base64"));
  decipher.setAuthTag(Buffer.from(enc.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(enc.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function isEncryptionConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}
