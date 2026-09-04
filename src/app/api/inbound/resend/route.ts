import { NextResponse } from "next/server";
import { handleInboundEmail } from "@/lib/agents/pipeline";
import { parseInboundPayload, verifyWebhookSignature } from "@/lib/email/inbound";
import { createLogger, errorMessage } from "@/lib/logger";

const log = createLogger("api:inbound");

export const runtime = "nodejs";
// Answering involves retrieval, generation and a grounding pass.
export const maxDuration = 120;

/**
 * Resend inbound webhook.
 *
 * Setup: point the MX records for RESEND_INBOUND_DOMAIN at Resend, then add a
 * webhook for `email.received` pointing at this route.
 *
 * Always returns 200 for authenticated deliveries, even when processing fails —
 * a non-2xx makes Resend retry, and retrying a message that failed for a
 * deterministic reason just fails again. Failures are recorded in
 * `inbound_emails.status` instead, where they are visible and re-runnable.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  const verification = verifyWebhookSignature(rawBody, {
    "svix-id": request.headers.get("svix-id"),
    "svix-timestamp": request.headers.get("svix-timestamp"),
    "svix-signature": request.headers.get("svix-signature"),
  });

  if (!verification.valid) {
    log.warn("Rejected webhook with an invalid signature", { reason: verification.reason });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Body was not valid JSON" }, { status: 400 });
  }

  const eventType = (payload as { type?: string })?.type;

  // Resend sends delivery events to the same endpoint; only inbound mail is ours.
  if (eventType && eventType !== "email.received" && eventType !== "inbound.received") {
    return NextResponse.json({ ok: true, skipped: eventType });
  }

  const message = parseInboundPayload(payload);
  if (!message) {
    log.warn("Could not parse inbound payload");
    return NextResponse.json({ ok: true, skipped: "unparseable" });
  }

  try {
    const outcome = await handleInboundEmail(message);
    log.info("Inbound handled", { status: outcome.status, from: message.from.email });
    return NextResponse.json({ ok: true, outcome });
  } catch (e) {
    log.error("Inbound processing threw", { error: errorMessage(e) });
    return NextResponse.json({ ok: true, error: errorMessage(e) });
  }
}

/** Some providers probe the endpoint with a GET before enabling it. */
export function GET() {
  return NextResponse.json({ ok: true, endpoint: "resend-inbound" });
}
