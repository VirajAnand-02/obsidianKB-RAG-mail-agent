import "dotenv/config";
import { createHmac } from "node:crypto";
import { env } from "@/lib/env";
import { errorMessage } from "@/lib/logger";

/**
 * Simulates a Resend inbound webhook against a running server.
 *
 *   npm run mail:inbound -- "What is the default retry count?"
 *   npm run mail:inbound -- "..." --from someone@example.com --url http://localhost:3000
 *
 * Exercises the whole pipeline — triage, retrieval, drafting, grounding gate —
 * without waiting on MX records or DNS propagation. This is how to test the
 * answering path before inbound mail is actually routed.
 *
 * The payload is signed exactly the way Svix signs Resend's webhooks, so the
 * signature verification path is tested too rather than bypassed.
 */

function sign(payload: string, secret: string, id: string, timestamp: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signature = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  return `v1,${signature}`;
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function main() {
  const question = process.argv.slice(2).find((a) => !a.startsWith("--") && !a.includes("@"));

  if (!question) {
    console.error(
      '\nUsage: npm run mail:inbound -- "your question" [--from a@b.com] [--url http://localhost:3000]\n',
    );
    process.exit(2);
  }

  const baseUrl = arg("url", env.NEXT_PUBLIC_APP_URL || "http://localhost:3000");
  const from = arg("from", "tester@example.com");
  const subject = arg("subject", "Quick question");
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/inbound/resend`;

  // Shaped like Resend's `email.received` event.
  const eventId = `evt_test_${Date.now()}`;
  const payload = JSON.stringify({
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: eventId,
      message_id: `<${eventId}@example.com>`,
      from,
      to: [env.RESEND_REPLY_TO || `ask@${env.RESEND_INBOUND_DOMAIN || "example.com"}`],
      subject,
      text: question,
      headers: { "Message-ID": `<${eventId}@example.com>` },
      created_at: new Date().toISOString(),
    },
  });

  const id = `msg_${Date.now()}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const headers: Record<string, string> = { "content-type": "application/json" };

  if (env.RESEND_WEBHOOK_SECRET) {
    headers["svix-id"] = id;
    headers["svix-timestamp"] = timestamp;
    headers["svix-signature"] = sign(payload, env.RESEND_WEBHOOK_SECRET, id, timestamp);
    console.log("\nSigned with RESEND_WEBHOOK_SECRET");
  } else {
    // Development skips verification; production would reject this.
    console.log("\nRESEND_WEBHOOK_SECRET not set — sending unsigned (dev only)");
  }

  console.log(`  POST ${endpoint}`);
  console.log(`  from    ${from}`);
  console.log(`  subject ${subject}`);
  console.log(`  body    ${question}\n`);

  let response: Response;
  try {
    response = await fetch(endpoint, { method: "POST", headers, body: payload });
  } catch (e) {
    throw new Error(
      `Could not reach ${endpoint}: ${errorMessage(e)}\n` +
        "  Is the dev server running? Start it with `npm run dev`.",
    );
  }

  const json = await response.json().catch(() => ({}));
  console.log(`HTTP ${response.status}`);
  console.log(JSON.stringify(json, null, 2));

  const outcome = (json as { outcome?: { status?: string; reason?: string } }).outcome;
  if (outcome?.status) {
    const explain: Record<string, string> = {
      sent: "A reply was generated and sent (or logged, if MAIL_DRY_RUN is on).",
      queued: "The grounding gate held the draft for review — see /dashboard/review.",
      blocked: "The grounding gate refused to send; the sender got a not-found reply.",
      ignored: "Filtered before answering.",
      duplicate: "Already processed; webhook retries are deduplicated.",
      failed: "The pipeline errored — see the server log.",
    };
    console.log(`\n${outcome.status.toUpperCase()}: ${explain[outcome.status] ?? ""}`);
    if (outcome.reason) console.log(`  reason: ${outcome.reason}`);
  }
  console.log();
}

main().catch((e) => {
  console.error(`\n${errorMessage(e)}\n`);
  process.exit(1);
});
