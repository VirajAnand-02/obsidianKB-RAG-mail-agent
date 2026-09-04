import { generateText } from "ai";

import { getRuntimeConfig } from "@/lib/config";
import { getLanguageModel } from "@/lib/ai/registry";
import { renderPrompt } from "@/lib/prompts";
import { gateDraft } from "@/lib/agents/grounding";
import { sendBulk, unsubscribeUrl } from "@/lib/email/resend";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getWorkspaceId, requireDefaultVaultId } from "@/lib/workspace";
import { countTokens } from "@/lib/rag/tokenize";
import { createLogger, errorMessage } from "@/lib/logger";
import type { RetrievedChunk } from "@/lib/types";

const log = createLogger("agent:newsletter");

/**
 * Scheduled digest of recently added or changed notes.
 *
 * Composed from the same vault as email answers and put through the same
 * grounding gate: a newsletter that misreports an unfinished note is exactly as
 * damaging as a reply that does, and it reaches more people.
 */

interface RecentNote {
  note_id: string;
  path: string;
  title: string;
  tags: string[];
  word_count: number;
  note_updated_at: string;
  excerpt: string | null;
}

export interface NewsletterDraft {
  issueId: string;
  title: string;
  bodyMarkdown: string;
  sourceNotes: { noteId: string; title: string; path: string }[];
  status: "draft" | "pending_review" | "approved" | "blocked";
  groundingScore: number;
  rationale: string;
}

/** Splits the model's `SUBJECT: ...` first line from the body. */
function splitSubject(output: string, fallback: string): { subject: string; body: string } {
  const match = output.match(/^\s*SUBJECT:\s*(.+?)\s*\n([\s\S]*)$/);
  if (!match) return { subject: fallback, body: output.trim() };
  return { subject: match[1].trim(), body: match[2].trim() };
}

export async function composeNewsletter(options: {
  vaultId?: string;
  lookbackDays?: number;
  maxItems?: number;
} = {}): Promise<NewsletterDraft | null> {
  const config = await getRuntimeConfig();
  const db = supabaseAdmin();
  const workspaceId = await getWorkspaceId();
  const vaultId = options.vaultId ?? (await requireDefaultVaultId());

  const lookbackDays = options.lookbackDays ?? config.newsletter.lookbackDays;
  const maxItems = options.maxItems ?? config.newsletter.maxItems;
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const { data, error } = await db.rpc("recent_notes", {
    p_vault_id: vaultId,
    p_since: since.toISOString(),
    p_limit: maxItems * 2, // over-fetch so thin notes can be dropped
  });

  if (error) throw new Error(`Could not read recent notes: ${error.message}`);

  // Stubs and link dumps make for filler paragraphs; require real prose.
  const notes = ((data ?? []) as RecentNote[])
    .filter((n) => n.excerpt && n.word_count >= 40)
    .slice(0, maxItems);

  if (notes.length === 0) {
    log.info("No newsletter-worthy notes in the period", { lookbackDays });
    return null;
  }

  const notesBlock = notes
    .map(
      (n, i) =>
        `[N${i + 1}] ${n.title}\n` +
        `tags: ${n.tags?.length ? n.tags.join(", ") : "none"} | updated: ${n.note_updated_at?.slice(0, 10)}\n` +
        `---\n${(n.excerpt ?? "").slice(0, 1500)}\n`,
    )
    .join("\n");

  const period =
    lookbackDays === 7
      ? "the past week"
      : lookbackDays === 1
        ? "the past day"
        : `the past ${lookbackDays} days`;

  const { text: promptText } = await renderPrompt("newsletterAgent", {
    vaultName: await getVaultName(vaultId),
    period,
    noteCount: String(notes.length),
    notes: notesBlock,
    today: new Date().toISOString().slice(0, 10),
  });

  const { model } = await getLanguageModel();
  const { text } = await generateText({
    model,
    prompt: promptText,
    // A digest should read less mechanically than a factual reply.
    temperature: Math.max(config.llm.temperature, 0.4),
    maxOutputTokens: config.llm.maxOutputTokens,
  });

  const fallbackTitle = `Notes from ${period}`;
  const { subject, body } = splitSubject(text, fallbackTitle);

  // The gate expects retrieval-shaped context, so the source notes are wrapped
  // to look like retrieved chunks. Same verification, different surface.
  const pseudoChunks: RetrievedChunk[] = notes.map((n, i) => ({
    chunkId: n.note_id,
    noteId: n.note_id,
    path: n.path,
    title: n.title,
    headingPath: [n.title],
    content: n.excerpt ?? "",
    ordinal: 0,
    tokenCount: countTokens(n.excerpt ?? ""),
    tags: n.tags ?? [],
    noteUpdatedAt: n.note_updated_at,
    similarity: null,
    ftsScore: null,
    score: 1,
    citationId: `N${i + 1}`,
  }));

  const contextBlock = notesBlock;
  const decision = await gateDraft({
    question: `Summarise the notes changed in ${period}.`,
    draft: body,
    chunks: pseudoChunks,
    contextBlock,
  });

  const status =
    decision.action === "block"
      ? "blocked"
      : decision.action === "review" || config.newsletter.requireApproval
        ? "pending_review"
        : "approved";

  const { data: issue, error: issueError } = await db
    .from("newsletter_issues")
    .insert({
      workspace_id: workspaceId,
      vault_id: vaultId,
      title: subject,
      body_markdown: body,
      status,
      grounding_verdict: decision.report.verdict,
      grounding_score: decision.report.score,
      grounding: { ...decision.report, rationale: decision.rationale },
      source_notes: notes.map((n) => ({ noteId: n.note_id, title: n.title, path: n.path })),
      covers_since: since.toISOString(),
    })
    .select("id")
    .single();

  if (issueError) throw new Error(`Could not save the newsletter issue: ${issueError.message}`);

  log.info("Newsletter drafted", { issueId: issue.id, status, notes: notes.length });

  return {
    issueId: issue.id as string,
    title: subject,
    bodyMarkdown: body,
    sourceNotes: notes.map((n) => ({ noteId: n.note_id, title: n.title, path: n.path })),
    status: status as NewsletterDraft["status"],
    groundingScore: decision.report.score,
    rationale: decision.rationale,
  };
}

/** Sends an approved issue to every active subscriber. */
export async function sendNewsletterIssue(
  issueId: string,
  actor = "system",
): Promise<{ sent: number; failed: number; errors: string[] }> {
  const db = supabaseAdmin();
  const workspaceId = await getWorkspaceId();

  const { data: issue, error } = await db
    .from("newsletter_issues")
    .select("*")
    .eq("id", issueId)
    .single();

  if (error) throw new Error(`Issue not found: ${error.message}`);
  if (issue.status === "sent") throw new Error("This issue has already been sent.");
  if (issue.status === "blocked") {
    throw new Error("This issue was blocked by the grounding gate and cannot be sent.");
  }

  const { data: subscribers } = await db
    .from("newsletter_subscribers")
    .select("email, unsubscribe_token")
    .eq("workspace_id", workspaceId)
    .eq("status", "active");

  const recipients = (subscribers ?? []).map((s) => ({
    email: s.email as string,
    unsubscribeUrl: unsubscribeUrl(s.unsubscribe_token as string),
  }));

  if (recipients.length === 0) {
    log.warn("Newsletter has no active subscribers", { issueId });
    return { sent: 0, failed: 0, errors: ["No active subscribers."] };
  }

  await db.from("newsletter_issues").update({ status: "sending" }).eq("id", issueId);

  try {
    const result = await sendBulk(recipients, {
      subject: issue.title as string,
      bodyMarkdown: issue.body_markdown as string,
      showDisclosure: false,
      tags: [{ name: "kind", value: "newsletter" }],
    });

    await db
      .from("newsletter_issues")
      .update({
        status: result.sent > 0 ? "sent" : "failed",
        sent_at: new Date().toISOString(),
        recipient_count: result.sent,
      })
      .eq("id", issueId);

    log.info("Newsletter sent", { issueId, ...result, actor });
    return result;
  } catch (e) {
    await db.from("newsletter_issues").update({ status: "failed" }).eq("id", issueId);
    throw new Error(`Newsletter send failed: ${errorMessage(e)}`);
  }
}

async function getVaultName(vaultId: string): Promise<string> {
  const { data } = await supabaseAdmin().from("vaults").select("name").eq("id", vaultId).single();
  return (data?.name as string) ?? "the knowledge base";
}
