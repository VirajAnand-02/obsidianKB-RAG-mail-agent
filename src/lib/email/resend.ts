import { Resend } from "resend";
import { getRuntimeConfig } from "@/lib/config";
import { resolveApiKey } from "@/lib/ai/registry";
import { renderEmail } from "@/lib/email/render";
import { createLogger, errorMessage } from "@/lib/logger";

const log = createLogger("email:resend");

/**
 * Outbound email via Resend, on a verified custom domain.
 *
 * Everything routes through `sendEmail` so that dry-run mode, threading headers
 * and the send log are impossible to bypass by accident.
 */

let client: Resend | null = null;

async function getClient(): Promise<Resend> {
  if (client) return client;
  const apiKey = await resolveApiKey("resend");
  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY is not set. Add it to .env or Settings -> Providers before sending email.",
    );
  }
  client = new Resend(apiKey);
  return client;
}

export interface SendOptions {
  to: string | string[];
  subject: string;
  bodyMarkdown: string;
  sources?: { title: string; path: string }[];
  replyTo?: string;
  /** RFC 5322 Message-ID being replied to, so clients thread the reply. */
  inReplyTo?: string;
  references?: string[];
  showDisclosure?: boolean;
  tags?: { name: string; value: string }[];
  /** Overrides the configured dry-run setting for this one send. */
  forceSend?: boolean;
}

export interface SendResult {
  id: string | null;
  dryRun: boolean;
  to: string[];
  subject: string;
  html: string;
  text: string;
}

/**
 * Sends one email.
 *
 * Sending is live by default (`email.dryRun: false` in src/lib/app-config.ts).
 * Setting `dryRun: true` renders and logs the message without handing it to
 * Resend, which is useful when working on templates or the pipeline.
 */
export async function sendEmail(options: SendOptions): Promise<SendResult> {
  const config = await getRuntimeConfig();
  const to = Array.isArray(options.to) ? options.to : [options.to];

  const { html, text } = renderEmail({
    bodyMarkdown: options.bodyMarkdown,
    sources: options.sources,
    showDisclosure: options.showDisclosure,
  });

  const dryRun = options.forceSend ? false : config.email.dryRun;

  if (dryRun) {
    log.info("Dry run — email rendered but not sent", {
      to,
      subject: options.subject,
      bytes: html.length,
    });
    return { id: null, dryRun: true, to, subject: options.subject, html, text };
  }

  const from = config.email.fromEmail;
  if (!from) {
    throw new Error(
      "RESEND_FROM_EMAIL is not set. It must be an address on a domain verified in Resend.",
    );
  }

  const headers: Record<string, string> = {};
  if (options.inReplyTo) {
    headers["In-Reply-To"] = options.inReplyTo;
    // Threading needs References to include the whole chain, not just the parent.
    headers["References"] = (options.references ?? [options.inReplyTo]).join(" ");
  }

  const resend = await getClient();
  const { data, error } = await resend.emails.send({
    from: config.email.fromName ? `${config.email.fromName} <${from}>` : from,
    to,
    subject: options.subject,
    html,
    text,
    replyTo: options.replyTo ?? config.email.replyTo ?? undefined,
    headers: Object.keys(headers).length ? headers : undefined,
    tags: options.tags,
  });

  if (error) {
    log.error("Resend rejected the message", { error: error.message, to });
    throw new Error(`Resend failed to send: ${error.message}`);
  }

  log.info("Email sent", { id: data?.id, to, subject: options.subject });
  return { id: data?.id ?? null, dryRun: false, to, subject: options.subject, html, text };
}
