import { getRuntimeConfig } from "@/lib/config";
import { answerQuestion, composeNotFoundReply, buildReplySubject, humaniseSenderName } from "@/lib/agents/answer";
import { gateDraft } from "@/lib/agents/grounding";
import { triageEmail } from "@/lib/agents/triage";
import { extractBody, isAutomatedMessage, isSenderAllowed } from "@/lib/email/inbound";
import { sendEmail } from "@/lib/email/resend";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getWorkspaceId, requireDefaultVaultId } from "@/lib/workspace";
import { createLogger, errorMessage } from "@/lib/logger";
import type { GateAction, InboundMessage, RetrievedChunk } from "@/lib/types";

const log = createLogger("agent:pipeline");

/**
 * The inbound question pipeline.
 *
 *   webhook -> dedupe -> filters -> triage -> retrieve -> draft
 *           -> grounding gate -> send | queue for review | block
 *
 * Every path ends with a row in `outbound_emails`, including blocked ones, so
 * the dashboard shows what the system decided and why rather than silently
 * dropping messages.
 */

export type PipelineOutcome =
  | { status: "ignored"; reason: string; inboundId?: string }
  | { status: "duplicate"; inboundId: string }
  | { status: "sent"; inboundId: string; outboundId: string; dryRun: boolean }
  | { status: "queued"; inboundId: string; outboundId: string; reason: string }
  | { status: "blocked"; inboundId: string; outboundId: string; reason: string }
  | { status: "failed"; inboundId?: string; error: string };

export async function handleInboundEmail(message: InboundMessage): Promise<PipelineOutcome> {
  const db = supabaseAdmin();
  const config = await getRuntimeConfig();
  const workspaceId = await getWorkspaceId();

  // ---- 1. dedupe -----------------------------------------------------------
  // Webhooks retry. Answering the same email twice is worse than missing one.
  if (message.providerEventId) {
    const { data: existing } = await db
      .from("inbound_emails")
      .select("id")
      .eq("provider_event_id", message.providerEventId)
      .maybeSingle();

    if (existing) {
      log.info("Duplicate webhook delivery ignored", { eventId: message.providerEventId });
      return { status: "duplicate", inboundId: existing.id as string };
    }
  }

  const body = extractBody(message);

  // ---- 2. cheap filters ----------------------------------------------------
  const automated = isAutomatedMessage(message);
  const allowed = isSenderAllowed(message.from.email, config.email.allowedSenderDomains);

  const rejection = automated.automated
    ? automated.reason!
    : !allowed
      ? `Sender domain is not in ALLOWED_SENDER_DOMAINS`
      : !body.trim()
        ? "Email body was empty after removing quoted text"
        : null;

  const thread = await upsertThread(workspaceId, message);

  const { data: inbound, error: inboundError } = await db
    .from("inbound_emails")
    .insert({
      workspace_id: workspaceId,
      thread_id: thread,
      provider_event_id: message.providerEventId ?? null,
      message_id: message.messageId ?? null,
      in_reply_to: message.inReplyTo ?? null,
      from_email: message.from.email,
      from_name: message.from.name ?? null,
      to_email: message.to,
      subject: message.subject,
      text_body: message.text ?? null,
      html_body: message.html ?? null,
      question: body || null,
      status: rejection ? "ignored" : "processing",
      reason: rejection,
      raw: message.raw ?? {},
      received_at: message.receivedAt,
    })
    .select("id")
    .single();

  if (inboundError) {
    log.error("Could not record inbound email", { error: inboundError.message });
    return { status: "failed", error: inboundError.message };
  }

  const inboundId = inbound.id as string;
  if (rejection) {
    log.info("Inbound email ignored", { reason: rejection, from: message.from.email });
    return { status: "ignored", reason: rejection, inboundId };
  }

  try {
    // ---- 3. rate limit -----------------------------------------------------
    const { data: sentToday } = await db.rpc("replies_sent_today", {
      p_workspace_id: workspaceId,
      p_email: message.from.email,
    });

    if ((sentToday ?? 0) >= config.email.rateLimitPerSenderPerDay) {
      const reason = `Sender reached the daily reply limit (${config.email.rateLimitPerSenderPerDay}).`;
      await markInbound(inboundId, "ignored", reason);
      return { status: "ignored", reason, inboundId };
    }

    // ---- 4. triage ---------------------------------------------------------
    const triage = await triageEmail({
      fromEmail: message.from.email,
      subject: message.subject,
      body,
    });

    if (triage.classification === "ignore") {
      await markInbound(inboundId, "ignored", triage.reason);
      return { status: "ignored", reason: triage.reason, inboundId };
    }

    const question = triage.question?.trim() || body;

    // Anything triage flagged for a human is drafted but never auto-sent.
    const forceReview = triage.classification === "human";

    // ---- 5. answer ---------------------------------------------------------
    const vaultId = await requireDefaultVaultId();
    const vaultName = await getVaultName(vaultId);

    const answer = await answerQuestion({
      vaultId,
      question,
      senderName: message.from.name,
      senderEmail: message.from.email,
      subject: message.subject,
      vaultName,
      workspaceId,
      source: "email",
    });

    // ---- 6. gate -----------------------------------------------------------
    let action: GateAction;
    let rationale: string;
    let groundingReport;
    let bodyMarkdown: string;

    if (answer.noContext) {
      // Nothing retrieved: reply honestly rather than drafting from nothing.
      bodyMarkdown = await composeNotFoundReply({
        senderName: message.from.name,
        senderEmail: message.from.email,
        question,
        topic: triage.topic,
        vaultName,
      });
      action = "send";
      rationale = "No relevant notes were retrieved; sent the not-found reply.";
      groundingReport = {
        score: 1,
        verdict: "skipped" as const,
        claims: [],
        unsupportedClaims: [],
        hallucinationRisk: "low" as const,
        missingCitations: false,
        reasoning: "Not-found replies make no factual claims, so grounding does not apply.",
      };
    } else {
      const decision = await gateDraft({
        question,
        draft: answer.bodyMarkdown,
        chunks: answer.retrieval,
        contextBlock: answer.retrievalResult.contextBlock,
      });

      bodyMarkdown = answer.bodyMarkdown;
      action = decision.action;
      rationale = decision.rationale;
      groundingReport = decision.report;
    }

    if (forceReview && action === "send") {
      action = "review";
      rationale = `Triage flagged this for a human (${triage.reason}), so it was not sent automatically.`;
    }

    // ---- 7. persist + deliver ---------------------------------------------
    const status =
      action === "send" ? "sending" : action === "review" ? "pending_review" : "blocked";

    const { data: outbound, error: outboundError } = await db
      .from("outbound_emails")
      .insert({
        workspace_id: workspaceId,
        vault_id: vaultId,
        thread_id: thread,
        inbound_id: inboundId,
        kind: "reply",
        to_email: message.from.email,
        subject: buildReplySubject(message.subject),
        body_markdown: bodyMarkdown,
        status,
        grounding_verdict: groundingReport.verdict,
        grounding_score: groundingReport.score,
        grounding: { ...groundingReport, rationale },
        retrieval: serialiseRetrieval(answer.retrieval),
        generation: answer.generation,
      })
      .select("id")
      .single();

    if (outboundError) throw new Error(outboundError.message);
    const outboundId = outbound.id as string;

    if (action === "review") {
      await markInbound(inboundId, "answered", "Draft queued for human review");
      log.info("Draft queued for review", { outboundId, score: groundingReport.score });
      return { status: "queued", inboundId, outboundId, reason: rationale };
    }

    if (action === "block") {
      // Blocked drafts are never sent, but the sender still gets an honest
      // "nothing here" reply rather than silence.
      const fallback = await composeNotFoundReply({
        senderName: message.from.name,
        senderEmail: message.from.email,
        question,
        topic: triage.topic,
        vaultName,
      });

      await sendEmail({
        to: message.from.email,
        subject: buildReplySubject(message.subject),
        bodyMarkdown: fallback,
        inReplyTo: message.messageId,
      }).catch((e) => log.warn("Could not send the fallback reply", { error: errorMessage(e) }));

      await markInbound(inboundId, "answered", `Blocked by grounding: ${rationale}`);
      log.warn("Draft blocked by the grounding gate", { outboundId, rationale });
      return { status: "blocked", inboundId, outboundId, reason: rationale };
    }

    const result = await sendEmail({
      to: message.from.email,
      subject: buildReplySubject(message.subject),
      bodyMarkdown,
      sources: sourcesFor(answer.retrieval),
      inReplyTo: message.messageId,
      tags: [{ name: "kind", value: "reply" }],
    });

    await db
      .from("outbound_emails")
      .update({
        status: "sent",
        provider_message_id: result.id,
        body_html: result.html,
        sent_at: new Date().toISOString(),
      })
      .eq("id", outboundId);

    await markInbound(inboundId, "answered", null);

    log.info("Reply sent", { outboundId, dryRun: result.dryRun });
    return { status: "sent", inboundId, outboundId, dryRun: result.dryRun };
  } catch (e) {
    const error = errorMessage(e);
    await markInbound(inboundId, "failed", error);
    log.error("Pipeline failed", { inboundId, error });
    return { status: "failed", inboundId, error };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function markInbound(id: string, status: string, reason: string | null) {
  await supabaseAdmin().from("inbound_emails").update({ status, reason }).eq("id", id);
}

async function upsertThread(workspaceId: string, message: InboundMessage): Promise<string | null> {
  const db = supabaseAdmin();

  const { data: existing } = await db
    .from("email_threads")
    .select("id")
    .eq("workspace_id", workspaceId)
    .ilike("participant", message.from.email)
    .maybeSingle();

  if (existing) {
    await db
      .from("email_threads")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", existing.id);
    return existing.id as string;
  }

  const { data: created } = await db
    .from("email_threads")
    .insert({
      workspace_id: workspaceId,
      participant: message.from.email,
      subject: message.subject,
      root_message_id: message.messageId ?? null,
    })
    .select("id")
    .single();

  return (created?.id as string) ?? null;
}

async function getVaultName(vaultId: string): Promise<string> {
  const { data } = await supabaseAdmin().from("vaults").select("name").eq("id", vaultId).single();
  return (data?.name as string) ?? "the knowledge base";
}

/** Trims retrieved chunks to what the reviewer UI needs, without full bodies. */
function serialiseRetrieval(chunks: RetrievedChunk[]) {
  return chunks.map((c) => ({
    citationId: c.citationId,
    chunkId: c.chunkId,
    noteId: c.noteId,
    path: c.path,
    title: c.title,
    headingPath: c.headingPath,
    score: c.score,
    similarity: c.similarity,
    isNeighbor: c.isNeighbor ?? false,
    excerpt: c.content.slice(0, 600),
  }));
}

/** Unique source notes, in citation order, for the email footer. */
export function sourcesFor(chunks: RetrievedChunk[]): { title: string; path: string }[] {
  const seen = new Set<string>();
  const out: { title: string; path: string }[] = [];

  for (const chunk of chunks) {
    if (chunk.isNeighbor) continue;
    if (seen.has(chunk.path)) continue;
    seen.add(chunk.path);
    out.push({ title: chunk.title, path: chunk.path });
  }
  return out;
}

/**
 * Sends a draft that a human approved in the review queue.
 * Uses the edited body when the reviewer changed it.
 */
export async function sendApprovedDraft(
  outboundId: string,
  actor: string,
): Promise<{ sent: boolean; dryRun: boolean }> {
  const db = supabaseAdmin();

  const { data: draft, error } = await db
    .from("outbound_emails")
    .select("*")
    .eq("id", outboundId)
    .single();

  if (error) throw new Error(`Draft not found: ${error.message}`);
  if (draft.status === "sent") throw new Error("This draft has already been sent.");

  const bodyMarkdown = (draft.edited_body_markdown as string) || (draft.body_markdown as string);
  await db.from("outbound_emails").update({ status: "sending" }).eq("id", outboundId);

  try {
    const retrieval = (draft.retrieval ?? []) as { title: string; path: string; isNeighbor?: boolean }[];
    const sources = retrieval
      .filter((r) => !r.isNeighbor)
      .map((r) => ({ title: r.title, path: r.path }));

    // A human read this one, so the "answered automatically" line is dropped.
    const result = await sendEmail({
      to: draft.to_email as string,
      subject: draft.subject as string,
      bodyMarkdown,
      sources: dedupeSources(sources),
      showDisclosure: false,
      tags: [{ name: "kind", value: "reviewed-reply" }],
    });

    await db
      .from("outbound_emails")
      .update({
        status: "sent",
        provider_message_id: result.id,
        body_html: result.html,
        sent_at: new Date().toISOString(),
        reviewed_by: actor,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", outboundId);

    await db.from("review_actions").insert({
      outbound_id: outboundId,
      action: "approve",
      actor,
      note: result.dryRun ? "Approved (dry run — not delivered)" : "Approved and sent",
    });

    return { sent: true, dryRun: result.dryRun };
  } catch (e) {
    await db
      .from("outbound_emails")
      .update({ status: "failed", error: errorMessage(e) })
      .eq("id", outboundId);
    throw e;
  }
}

function dedupeSources(sources: { title: string; path: string }[]) {
  const seen = new Set<string>();
  return sources.filter((s) => (seen.has(s.path) ? false : (seen.add(s.path), true)));
}
