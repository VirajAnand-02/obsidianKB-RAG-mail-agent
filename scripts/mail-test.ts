import "dotenv/config";
import { env } from "@/lib/env";
import { getRuntimeConfig } from "@/lib/config";
import { sendEmail } from "@/lib/email/resend";
import { errorMessage } from "@/lib/logger";

/**
 * Sends one test email through Resend.
 *
 *   npm run mail:test -- you@example.com
 *   npm run mail:test -- you@example.com --live
 *
 * Without `--live` this renders the message and prints it, honouring
 * `email.dryRun` from src/lib/app-config.ts. `--live` forces an actual send
 * regardless of that setting.
 */

const BODY = `Hello,

This is a test message from **Obsi-Relay**, confirming that Resend is wired up
correctly on your domain.

If you are reading this in your inbox rather than in spam, then:

- the API key is valid
- the sending domain is verified
- SPF and DKIM are aligned

A real reply would cite the notes it came from, like this [C1], and list its
sources underneath.

Nothing else is needed.`;

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const to = args.find((a) => !a.startsWith("--"));

  if (!to) {
    console.error(
      "\nUsage: npm run mail:test -- <recipient@example.com> [--live]\n\n" +
        "  Omit --live to render without sending.\n",
    );
    process.exit(2);
  }

  const config = await getRuntimeConfig();

  console.log("\nResend configuration");
  console.log(`  API key        ${env.RESEND_API_KEY ? `set (${env.RESEND_API_KEY.slice(0, 8)}…)` : "MISSING"}`);
  console.log(`  From           ${config.email.fromName} <${config.email.fromEmail}>`);
  console.log(`  Reply-To       ${config.email.replyTo || "(none)"}`);
  console.log(`  Dry run        ${config.email.dryRun}${live ? " (overridden by --live)" : ""}`);
  console.log(`  To             ${to}\n`);

  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not set in .env.");
  }
  if (!config.email.fromEmail || config.email.fromEmail.includes("yourdomain.com")) {
    throw new Error(
      `RESEND_FROM_EMAIL is still "${config.email.fromEmail}".\n` +
        "  Set it to an address on a domain you have verified in Resend.",
    );
  }

  try {
    const result = await sendEmail({
      to,
      subject: "Obsi-Relay test message",
      bodyMarkdown: BODY,
      sources: [{ title: "Engineering/Retry policy", path: "Engineering/Retry policy.md" }],
      forceSend: live,
      tags: [{ name: "kind", value: "test" }],
    });

    if (result.dryRun) {
      console.log("Dry run — nothing was delivered.\n");
      console.log("Plain-text part:\n");
      console.log(result.text.split("\n").map((l) => `  ${l}`).join("\n"));
      console.log(`\n  (${result.html.length} bytes of HTML also rendered)`);
      console.log("\nRe-run with --live to actually send it.\n");
    } else {
      console.log(`Sent. Resend message id: ${result.id}\n`);
      console.log("If it does not arrive within a minute, check:");
      console.log("  - Resend dashboard -> Emails, for a bounce or block");
      console.log("  - your spam folder");
      console.log("  - that the domain shows Verified in Resend -> Domains\n");
    }
  } catch (e) {
    const message = errorMessage(e);
    console.error(`\nSend failed: ${message}\n`);

    if (/domain is not verified|not verified/i.test(message)) {
      console.error("  The sending domain is not verified yet. Add the DNS records shown");
      console.error("  in Resend -> Domains and wait for propagation.\n");
    } else if (/API key|unauthorized|401/i.test(message)) {
      console.error("  The API key was rejected. Check RESEND_API_KEY, and that the key");
      console.error("  has Sending access rather than being read-only.\n");
    } else if (/testing emails to your own/i.test(message)) {
      console.error("  Resend restricts unverified accounts to your own address.");
      console.error("  Verify a domain, or send the test to the address you signed up with.\n");
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\n${errorMessage(e)}\n`);
  process.exit(1);
});
