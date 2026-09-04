import { supabaseAdmin } from "@/lib/supabase/admin";
import type { GroundingClaim, GroundingVerdict } from "@/lib/types";

/**
 * Message traces.
 *
 * Reconstructs the full journey of one inbound email — received, filtered,
 * retrieved, drafted, judged, delivered — from the rows the pipeline already
 * writes. Nothing new is recorded for this; the tables were always there, they
 * were just never surfaced.
 *
 * The point is answering "why did it do that?" without a database client. When
 * a reply is wrong, the useful question is almost never "what did it say" but
 * "which chunks did it see, and what did the judge think" — so the trace keeps
 * those side by side.
 */

export type TraceOutcome =
  | "sent"
  | "awaiting review"
  | "blocked"
  | "rejected"
  | "ignored"
  | "failed"
  | "processing";

export interface TraceRetrievalItem {
  citationId?: string;
  path: string;
  title: string;
  score?: number;
  similarity?: number | null;
  isNeighbor?: boolean;
  excerpt?: string;
}

export interface TraceSummary {
  inboundId: string;
  receivedAt: string;
  fromEmail: string;
  fromName: string | null;
  subject: string | null;
  question: string | null;
  inboundStatus: string;
  reason: string | null;
  outcome: TraceOutcome;
  groundingScore: number | null;
  groundingVerdict: GroundingVerdict | null;
  sentAt: string | null;
  /** Wall-clock time from arrival to delivery, when it got that far. */
  durationMs: number | null;
  outboundId: string | null;
}

export interface TraceDetail extends TraceSummary {
  toEmail: string | null;
  messageId: string | null;
  textBody: string | null;
  htmlBody: string | null;
  raw: unknown;
  outbound: {
    id: string;
    subject: string;
    bodyMarkdown: string;
    editedBodyMarkdown: string | null;
    status: string;
    error: string | null;
    providerMessageId: string | null;
    reviewedBy: string | null;
    reviewedAt: string | null;
    reviewNote: string | null;
    createdAt: string;
    grounding: {
      score: number | null;
      verdict: GroundingVerdict | null;
      reasoning?: string;
      rationale?: string;
      claims: GroundingClaim[];
      hallucinationRisk?: string;
      missingCitations?: boolean;
    };
    retrieval: TraceRetrievalItem[];
    generation: {
      provider?: string;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      latencyMs?: number;
    };
  } | null;
  reviewActions: {
    action: string;
    actor: string;
    note: string | null;
    createdAt: string;
  }[];
}

/**
 * Maps the two status columns onto one outcome.
 *
 * The pipeline stores state in two places — `inbound_emails.status` for
 * everything filtered before drafting, and `outbound_emails.status` after — so
 * a single readable outcome has to consider both.
 */
function deriveOutcome(inboundStatus: string, outboundStatus: string | null): TraceOutcome {
  if (outboundStatus) {
    switch (outboundStatus) {
      case "sent":
        return "sent";
      case "pending_review":
        return "awaiting review";
      case "blocked":
        return "blocked";
      case "rejected":
        return "rejected";
      case "failed":
        return "failed";
      default:
        return "processing";
    }
  }

  if (inboundStatus === "ignored") return "ignored";
  if (inboundStatus === "failed") return "failed";
  return "processing";
}

export interface ListTracesOptions {
  limit?: number;
  /** Filter by derived outcome. */
  outcome?: TraceOutcome | "all";
  /** Case-insensitive match on sender address or subject. */
  search?: string;
}

export async function listTraces(options: ListTracesOptions = {}): Promise<TraceSummary[]> {
  const db = supabaseAdmin();
  const limit = options.limit ?? 100;

  let query = db
    .from("inbound_emails")
    .select(
      "id, received_at, from_email, from_name, subject, question, status, reason, " +
        "outbound_emails(id, status, grounding_score, grounding_verdict, sent_at)",
    )
    .order("received_at", { ascending: false })
    .limit(limit);

  if (options.search?.trim()) {
    const term = `%${options.search.trim()}%`;
    query = query.or(`from_email.ilike.${term},subject.ilike.${term}`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Could not load traces: ${error.message}`);

  // supabase-js cannot infer a row type through the embedded select, so the
  // shape is asserted here and read defensively below.
  const rows = (data ?? []) as unknown as Record<string, unknown>[];

  const traces = rows.map((row) => {
    // A reply is one row, but the join returns an array.
    const outbound = (Array.isArray(row.outbound_emails)
      ? row.outbound_emails[0]
      : row.outbound_emails) as
      | {
          id: string;
          status: string;
          grounding_score: number | null;
          grounding_verdict: GroundingVerdict | null;
          sent_at: string | null;
        }
      | undefined;

    const receivedAt = row.received_at as string;
    const sentAt = outbound?.sent_at ?? null;

    return {
      inboundId: row.id as string,
      receivedAt,
      fromEmail: row.from_email as string,
      fromName: (row.from_name as string) ?? null,
      subject: (row.subject as string) ?? null,
      question: (row.question as string) ?? null,
      inboundStatus: row.status as string,
      reason: (row.reason as string) ?? null,
      outcome: deriveOutcome(row.status as string, outbound?.status ?? null),
      groundingScore: outbound?.grounding_score ?? null,
      groundingVerdict: outbound?.grounding_verdict ?? null,
      sentAt,
      durationMs: sentAt ? new Date(sentAt).getTime() - new Date(receivedAt).getTime() : null,
      outboundId: outbound?.id ?? null,
    } satisfies TraceSummary;
  });

  return options.outcome && options.outcome !== "all"
    ? traces.filter((t) => t.outcome === options.outcome)
    : traces;
}

export async function getTrace(inboundId: string): Promise<TraceDetail | null> {
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("inbound_emails")
    .select("*, outbound_emails(*)")
    .eq("id", inboundId)
    .maybeSingle();

  if (error) throw new Error(`Could not load trace: ${error.message}`);
  if (!data) return null;

  const outboundRow = (Array.isArray(data.outbound_emails)
    ? data.outbound_emails[0]
    : data.outbound_emails) as Record<string, unknown> | undefined;

  let reviewActions: TraceDetail["reviewActions"] = [];
  if (outboundRow?.id) {
    const { data: actions } = await db
      .from("review_actions")
      .select("action, actor, note, created_at")
      .eq("outbound_id", outboundRow.id as string)
      .order("created_at", { ascending: true });

    reviewActions = (actions ?? []).map((a) => ({
      action: a.action as string,
      actor: a.actor as string,
      note: (a.note as string) ?? null,
      createdAt: a.created_at as string,
    }));
  }

  const receivedAt = data.received_at as string;
  const sentAt = (outboundRow?.sent_at as string) ?? null;
  const grounding = (outboundRow?.grounding ?? {}) as Record<string, unknown>;

  return {
    inboundId: data.id as string,
    receivedAt,
    fromEmail: data.from_email as string,
    fromName: (data.from_name as string) ?? null,
    subject: (data.subject as string) ?? null,
    question: (data.question as string) ?? null,
    inboundStatus: data.status as string,
    reason: (data.reason as string) ?? null,
    outcome: deriveOutcome(data.status as string, (outboundRow?.status as string) ?? null),
    groundingScore: (outboundRow?.grounding_score as number) ?? null,
    groundingVerdict: (outboundRow?.grounding_verdict as GroundingVerdict) ?? null,
    sentAt,
    durationMs: sentAt ? new Date(sentAt).getTime() - new Date(receivedAt).getTime() : null,
    outboundId: (outboundRow?.id as string) ?? null,

    toEmail: (data.to_email as string) ?? null,
    messageId: (data.message_id as string) ?? null,
    textBody: (data.text_body as string) ?? null,
    htmlBody: (data.html_body as string) ?? null,
    raw: data.raw,

    outbound: outboundRow
      ? {
          id: outboundRow.id as string,
          subject: outboundRow.subject as string,
          bodyMarkdown: outboundRow.body_markdown as string,
          editedBodyMarkdown: (outboundRow.edited_body_markdown as string) ?? null,
          status: outboundRow.status as string,
          error: (outboundRow.error as string) ?? null,
          providerMessageId: (outboundRow.provider_message_id as string) ?? null,
          reviewedBy: (outboundRow.reviewed_by as string) ?? null,
          reviewedAt: (outboundRow.reviewed_at as string) ?? null,
          reviewNote: (outboundRow.review_note as string) ?? null,
          createdAt: outboundRow.created_at as string,
          grounding: {
            score: (outboundRow.grounding_score as number) ?? null,
            verdict: (outboundRow.grounding_verdict as GroundingVerdict) ?? null,
            reasoning: grounding.reasoning as string | undefined,
            rationale: grounding.rationale as string | undefined,
            claims: (grounding.claims ?? []) as GroundingClaim[],
            hallucinationRisk: grounding.hallucinationRisk as string | undefined,
            missingCitations: grounding.missingCitations as boolean | undefined,
          },
          retrieval: (outboundRow.retrieval ?? []) as TraceRetrievalItem[],
          generation: (outboundRow.generation ?? {}) as TraceDetail["outbound"] extends null
            ? never
            : { provider?: string; model?: string; latencyMs?: number },
        }
      : null,
    reviewActions,
  };
}

/** Counts by outcome, for the filter chips. */
export async function traceCounts(): Promise<Record<string, number>> {
  const traces = await listTraces({ limit: 500 });
  const counts: Record<string, number> = { all: traces.length };
  for (const t of traces) counts[t.outcome] = (counts[t.outcome] ?? 0) + 1;
  return counts;
}
