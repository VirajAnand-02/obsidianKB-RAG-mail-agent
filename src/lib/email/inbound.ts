import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import type { InboundMessage } from "@/lib/types";

const log = createLogger("email:inbound");

/**
 * Inbound email handling for the Resend webhook.
 *
 * Two jobs: prove the request actually came from Resend, and turn a raw email
 * into the single question the sender is asking.
 */

// ---------------------------------------------------------------------------
// Signature verification (Svix, which is what Resend uses)
// ---------------------------------------------------------------------------

const TOLERANCE_SECONDS = 5 * 60;

/**
 * Verifies a Svix signature.
 *
 * Implemented directly rather than pulling in the `svix` package: the scheme is
 * an HMAC over `${id}.${timestamp}.${body}`, and a webhook this security-
 * sensitive is worth being able to read in full.
 *
 * Without this, anyone who learns the endpoint URL can make the system email
 * arbitrary people on your verified domain.
 */
export function verifyWebhookSignature(
  payload: string,
  headers: {
    "svix-id"?: string | null;
    "svix-timestamp"?: string | null;
    "svix-signature"?: string | null;
  },
  secret: string = env.RESEND_WEBHOOK_SECRET,
): { valid: boolean; reason?: string } {
  if (!secret) {
    // Verification cannot be skipped in production; in development the webhook
    // is usually driven by a local test script.
    if (env.NODE_ENV === "production") {
      return { valid: false, reason: "RESEND_WEBHOOK_SECRET is not configured" };
    }
    log.warn("Webhook signature check skipped — RESEND_WEBHOOK_SECRET is not set");
    return { valid: true };
  }

  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signature = headers["svix-signature"];

  if (!id || !timestamp || !signature) {
    return { valid: false, reason: "Missing svix-id, svix-timestamp or svix-signature header" };
  }

  // Reject stale requests so a captured payload cannot be replayed later.
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { valid: false, reason: "Malformed svix-timestamp" };
  if (Math.abs(Date.now() / 1000 - sentAt) > TOLERANCE_SECONDS) {
    return { valid: false, reason: "Timestamp outside the allowed tolerance" };
  }

  // Secrets are given as `whsec_<base64>`.
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");

  // The header may carry several space-separated `v1,<sig>` versions.
  const provided = signature
    .split(" ")
    .map((part) => part.split(",")[1])
    .filter(Boolean);

  const expectedBuf = Buffer.from(expected);
  const matched = provided.some((candidate) => {
    const candidateBuf = Buffer.from(candidate);
    return (
      candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)
    );
  });

  return matched ? { valid: true } : { valid: false, reason: "Signature mismatch" };
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

interface ResendAddress {
  address?: string;
  email?: string;
  name?: string;
}

function readAddress(value: unknown): { email: string; name?: string } {
  if (typeof value === "string") {
    // "Name <a@b.com>" or a bare address.
    const match = value.match(/^\s*(?:"?([^"<]*)"?\s*)?<?([^\s<>]+@[^\s<>]+)>?\s*$/);
    if (match) return { email: match[2].toLowerCase(), name: match[1]?.trim() || undefined };
    return { email: value.trim().toLowerCase() };
  }

  if (Array.isArray(value) && value.length > 0) return readAddress(value[0]);

  if (value && typeof value === "object") {
    const addr = value as ResendAddress;
    const email = (addr.address ?? addr.email ?? "").toLowerCase();
    return { email, name: addr.name };
  }

  return { email: "" };
}

/** Normalises a Resend `email.received` webhook body into an InboundMessage. */
export function parseInboundPayload(body: unknown): InboundMessage | null {
  const event = body as {
    type?: string;
    data?: Record<string, unknown>;
  } & Record<string, unknown>;

  const data = (event.data ?? event) as Record<string, unknown>;
  if (!data || typeof data !== "object") return null;

  const from = readAddress(data.from);
  if (!from.email) {
    log.warn("Inbound payload had no usable From address");
    return null;
  }

  const to = readAddress(data.to);
  const headers = (data.headers ?? {}) as Record<string, string>;

  return {
    providerEventId: (data.email_id as string) ?? (data.id as string) ?? undefined,
    messageId: (data.message_id as string) ?? headers["Message-ID"] ?? headers["message-id"],
    inReplyTo: (data.in_reply_to as string) ?? headers["In-Reply-To"] ?? headers["in-reply-to"],
    from,
    to: to.email,
    subject: (data.subject as string) ?? "",
    text: (data.text as string) ?? undefined,
    html: (data.html as string) ?? undefined,
    receivedAt: (data.created_at as string) ?? new Date().toISOString(),
    raw: body,
  };
}

// ---------------------------------------------------------------------------
// Question extraction
// ---------------------------------------------------------------------------

/** Lines that mark the start of quoted history in common clients. */
const QUOTE_MARKERS = [
  /^On .+ wrote:$/im,
  /^-{2,}\s*Original Message\s*-{2,}$/im,
  /^_{10,}$/m,
  /^From:\s*.+$/im,
  /^Sent from my \w+/im,
  /^>{1,}\s?/m,
];

const SIGNATURE_MARKERS = [/^--\s*$/m, /^Best regards,?$/im, /^Cheers,?$/im, /^Thanks,?\s*$/im];

/**
 * Strips quoted history and signatures.
 *
 * Without this, a three-word follow-up in a long thread embeds as the whole
 * thread, and retrieval answers a question from four emails ago instead of the
 * one just asked.
 */
export function stripQuotedText(body: string): string {
  let text = body.replace(/\r\n/g, "\n");

  let cutAt = text.length;
  for (const marker of QUOTE_MARKERS) {
    const match = text.match(marker);
    if (match?.index !== undefined && match.index < cutAt) cutAt = match.index;
  }
  text = text.slice(0, cutAt);

  // Only trim a signature when there is real content before it.
  for (const marker of SIGNATURE_MARKERS) {
    const match = text.match(marker);
    if (match?.index !== undefined && match.index > 40) {
      text = text.slice(0, match.index);
      break;
    }
  }

  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** Crude HTML-to-text, used when an email has no plain-text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Best available body text for a message, cleaned of quotes and signatures. */
export function extractBody(message: InboundMessage): string {
  const raw = message.text?.trim() || (message.html ? htmlToText(message.html) : "");
  return stripQuotedText(raw);
}

/**
 * Cheap checks that a message should never be answered.
 * Run before the triage model, both to save a call and because auto-reply loops
 * are best broken by a header check rather than a judgement call.
 */
export function isAutomatedMessage(message: InboundMessage): { automated: boolean; reason?: string } {
  const headers = ((message.raw as { data?: { headers?: Record<string, string> } })?.data
    ?.headers ?? {}) as Record<string, string>;

  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);

  if (lower["auto-submitted"] && lower["auto-submitted"] !== "no") {
    return { automated: true, reason: "Auto-Submitted header present" };
  }
  if (lower["x-autoreply"] || lower["x-autorespond"] || lower["precedence"] === "bulk") {
    return { automated: true, reason: "Auto-reply or bulk precedence header" };
  }
  if (lower["list-unsubscribe"] || lower["list-id"]) {
    return { automated: true, reason: "Mailing list headers present" };
  }

  const local = message.from.email.split("@")[0];
  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce)/i.test(local)) {
    return { automated: true, reason: `Sender address "${local}" is a no-reply address` };
  }

  if (/^(out of office|automatic reply|auto:|undelivered|delivery status)/i.test(message.subject)) {
    return { automated: true, reason: "Subject indicates an automated message" };
  }

  return { automated: false };
}

/** Applies the ALLOWED_SENDER_DOMAINS allowlist. Empty list allows everyone. */
export function isSenderAllowed(email: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return allowedDomains.some((d) => {
    const normalised = d.toLowerCase().replace(/^@/, "");
    return domain === normalised || domain.endsWith(`.${normalised}`);
  });
}
