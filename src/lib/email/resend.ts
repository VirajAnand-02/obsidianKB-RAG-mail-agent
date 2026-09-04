import { Resend } from "resend";
import { env } from "@/lib/env";
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
  unsubscribeUrl?: string;
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
 * In dry-run mode (`MAIL_DRY_RUN=true`, the default) the message is rendered and
 * logged but never handed to Resend. That default is intentional: the failure
 * mode of this system is mailing real people, so sending has to be switched on
 * deliberately rather than being on from the first `npm run dev`.
 */
export async function sendEmail(options: SendOptions): Promise<SendResult> {
  const config = await getRuntimeConfig();
  const to = Array.isArray(options.to) ? options.to : [options.to];

  const { html, text } = renderEmail({
    bodyMarkdown: options.bodyMarkdown,
    sources: options.sources,
    unsubscribeUrl: options.unsubscribeUrl,
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
  if (options.unsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${options.unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
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

/**
 * Newsletter fan-out.
 *
 * Sent one message per subscriber rather than one with many recipients, so that
 * each carries its own unsubscribe link and no subscriber sees another's
 * address. Batched to stay within Resend's rate limits.
 */
export async function sendBulk(
  recipients: { email: string; unsubscribeUrl?: string }[],
  options: Omit<SendOptions, "to" | "unsubscribeUrl">,
  batchSize = 50,
): Promise<{ sent: number; failed: number; errors: string[] }> {
  const result = { sent: 0, failed: 0, errors: [] as string[] };

  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = recipients.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (recipient) => {
        try {
          await sendEmail({
            ...options,
            to: recipient.email,
            unsubscribeUrl: recipient.unsubscribeUrl,
          });
          result.sent++;
        } catch (e) {
          // One bad address must not stop the rest of the issue going out.
          result.failed++;
          result.errors.push(`${recipient.email}: ${errorMessage(e)}`);
        }
      }),
    );

    // Gentle pacing between batches; Resend rate-limits per second.
    if (i + batchSize < recipients.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return result;
}

export function unsubscribeUrl(token: string): string {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  return `${base}/unsubscribe?token=${encodeURIComponent(token)}`;
}
