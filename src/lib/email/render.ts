import { marked } from "marked";
import { appConfig } from "@/lib/app-config";

/**
 * Email HTML rendering.
 *
 * Agents produce markdown; email clients need inlined-style HTML. The template
 * below is deliberately plain: a table-free, single-column layout with inline
 * styles is the only thing that renders consistently across Gmail, Outlook and
 * Apple Mail, and a knowledge-base reply should look like a person's email
 * rather than a marketing campaign.
 */

marked.setOptions({ gfm: true, breaks: true });

const STYLES = {
  body: "margin:0;padding:0;background:#f6f7f9;",
  wrapper:
    "max-width:600px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;",
  card: "background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:28px;",
  footer: "margin-top:24px;font-size:12px;line-height:1.5;color:#6b7280;text-align:center;",
  link: "color:#2563eb;",
} as const;

/** Applies inline styles that survive Gmail's stylesheet stripping. */
function inlineStyles(html: string): string {
  return html
    .replace(/<h1>/g, '<h1 style="font-size:20px;font-weight:600;margin:0 0 16px;">')
    .replace(/<h2>/g, '<h2 style="font-size:17px;font-weight:600;margin:24px 0 10px;">')
    .replace(/<h3>/g, '<h3 style="font-size:15px;font-weight:600;margin:20px 0 8px;">')
    .replace(/<p>/g, '<p style="margin:0 0 14px;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 14px;padding-left:22px;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 14px;padding-left:22px;">')
    .replace(/<li>/g, '<li style="margin:0 0 6px;">')
    .replace(/<a /g, `<a style="${STYLES.link}" `)
    .replace(
      /<blockquote>/g,
      '<blockquote style="margin:0 0 14px;padding:8px 14px;border-left:3px solid #e5e7eb;color:#4b5563;">',
    )
    .replace(
      /<pre>/g,
      '<pre style="margin:0 0 14px;padding:12px;background:#f3f4f6;border-radius:6px;overflow-x:auto;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">',
    )
    .replace(
      /<code>/g,
      '<code style="background:#f3f4f6;border-radius:3px;padding:1px 4px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">',
    )
    .replace(/<pre style="([^"]*)"><code style="[^"]*">/g, '<pre style="$1"><code>')
    .replace(/<hr>/g, '<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0;">');
}

export function markdownToHtml(markdown: string): string {
  return inlineStyles(marked.parse(markdown, { async: false }) as string);
}

export interface EmailTemplateOptions {
  bodyMarkdown: string;
  /** Note paths backing the answer, listed under the body. */
  sources?: { title: string; path: string }[];
  footerNote?: string;
  /** Renders the "generated from notes" line. Off for human-reviewed sends. */
  showDisclosure?: boolean;
}

/**
 * Wraps rendered markdown in the shared email shell.
 *
 * The source list is included deliberately: telling the reader which notes an
 * answer came from is what makes an automated reply auditable rather than
 * something they have to take on faith.
 */
export function renderEmail(options: EmailTemplateOptions): { html: string; text: string } {
  const appName = appConfig.app.name;
  const body = markdownToHtml(options.bodyMarkdown);

  const sourcesHtml =
    options.sources && options.sources.length > 0
      ? `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;">
           <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em;">
             Sources
           </p>
           <ul style="margin:0;padding-left:18px;font-size:13px;color:#4b5563;">
             ${options.sources
               .map((s) => `<li style="margin:0 0 4px;">${escapeHtml(s.title)}</li>`)
               .join("")}
           </ul>
         </div>`
      : "";

  const disclosure =
    options.showDisclosure === false
      ? ""
      : `<p style="margin:0 0 6px;">Answered automatically from ${escapeHtml(appName)} notes.</p>`;

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(appName)}</title>
  </head>
  <body style="${STYLES.body}">
    <div style="${STYLES.wrapper}">
      <div style="${STYLES.card}">
        ${body}
        ${sourcesHtml}
      </div>
      <div style="${STYLES.footer}">
        ${disclosure}
        ${options.footerNote ? `<p style="margin:0 0 6px;">${escapeHtml(options.footerNote)}</p>` : ""}
      </div>
    </div>
  </body>
</html>`;

  return { html, text: toPlainText(options.bodyMarkdown, options.sources) };
}

/**
 * Plain-text alternative. Worth generating properly rather than shipping raw
 * markdown: it is what accessibility tools read and what spam filters compare
 * against the HTML part.
 */
export function toPlainText(
  markdown: string,
  sources?: { title: string; path: string }[],
): string {
  const text = markdown
    .replace(/```[\w]*\n([\s\S]*?)```/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^\s*[-*]\s+/gm, "- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!sources || sources.length === 0) return text;
  return `${text}\n\n---\nSources:\n${sources.map((s) => `- ${s.title}`).join("\n")}`;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
