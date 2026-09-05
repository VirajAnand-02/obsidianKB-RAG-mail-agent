import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { env } from "@/lib/env";

/**
 * AES-256-GCM for provider API keys that admins paste into the dashboard.
 *
 * Keys entered in the UI are stored encrypted so a leaked database dump does not
 * hand over the LLM and Resend accounts too. The encryption key itself lives
 * only in the environment (SETTINGS_ENCRYPTION_KEY).
 */

const ALGO = "aes-256-gcm";

/**
 * Resolves the 32-byte AES key.
 *
 * A base64 value decoding to exactly 32 bytes is used directly — that is what
 * `openssl rand -base64 32` produces and it stays byte-compatible with anything
 * already encrypted. Any other non-trivial secret is stretched to 32 bytes with
 * scrypt instead of being rejected outright, because the common failure was a
 * perfectly reasonable passphrase being refused on a technicality and reported
 * to the operator as "not set".
 */
const MIN_SECRET_LENGTH = 12;
const SCRYPT_SALT = "obsi-relay/settings-encryption/v1";

export type EncryptionStatus =
  | { ok: true; mode: "raw-32" | "derived" }
  | { ok: false; reason: string };

/** Non-throwing description of whether encryption can be used, and why not. */
export function encryptionStatus(): EncryptionStatus {
  const raw = (env.SETTINGS_ENCRYPTION_KEY ?? "").trim();

  if (!raw) {
    return { ok: false, reason: "SETTINGS_ENCRYPTION_KEY is not set." };
  }

  if (base64Bytes(raw)?.length === 32) return { ok: true, mode: "raw-32" };

  if (raw.length < MIN_SECRET_LENGTH) {
    return {
      ok: false,
      reason:
        `SETTINGS_ENCRYPTION_KEY is only ${raw.length} characters, which is too weak to ` +
        `encrypt provider keys. Use at least ${MIN_SECRET_LENGTH}, ideally from ` +
        "`openssl rand -base64 32`.",
    };
  }

  return { ok: true, mode: "derived" };
}

/** Decodes base64 strictly: returns null unless the value round-trips. */
function base64Bytes(value: string): Buffer | null {
  try {
    const buf = Buffer.from(value, "base64");
    return buf.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "") ? buf : null;
  } catch {
    return null;
  }
}

let derivedWarned = false;

function key(): Buffer {
  const status = encryptionStatus();
  if (!status.ok) throw new Error(status.reason);

  const raw = (env.SETTINGS_ENCRYPTION_KEY ?? "").trim();
  if (status.mode === "raw-32") return base64Bytes(raw)!;

  if (!derivedWarned) {
    derivedWarned = true;
    // Worth saying once: a stretched passphrase works, but a random 32-byte key
    // is stronger and is what the documentation asks for.
    console.warn(
      "[warn] crypto: SETTINGS_ENCRYPTION_KEY is not a 32-byte base64 value; deriving a key " +
        "with scrypt. Prefer `openssl rand -base64 32`.",
    );
  }
  return scryptSync(raw, SCRYPT_SALT, 32);
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
  return encryptionStatus().ok;
}
