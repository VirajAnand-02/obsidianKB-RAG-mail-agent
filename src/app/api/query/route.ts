import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";
import { answerQuestion } from "@/lib/agents/answer";
import { checkGrounding, applyGate } from "@/lib/agents/grounding";
import { retrieve } from "@/lib/rag/retrieve";
import { requireDefaultVaultId, getWorkspaceId } from "@/lib/workspace";
import { errorMessage } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Playground endpoint.
 *
 * Runs the full answering path — retrieval, drafting, grounding — and returns
 * every intermediate value. This is the fast loop for tuning retrieval: you can
 * see which chunks came back and what the judge thought without sending mail.
 */
export async function POST(request: Request) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  try {
    const body = (await request.json()) as {
      question?: string;
      vaultId?: string;
      retrieveOnly?: boolean;
      skipGrounding?: boolean;
    };

    const question = body.question?.trim();
    if (!question) {
      return NextResponse.json({ error: "A question is required." }, { status: 400 });
    }

    const vaultId = body.vaultId ?? (await requireDefaultVaultId());
    const retrieval = await retrieve({ vaultId, query: question });

    if (body.retrieveOnly) {
      return NextResponse.json({
        ok: true,
        queries: retrieval.queries,
        chunks: retrieval.chunks,
        contextTokens: retrieval.contextTokens,
        timings: retrieval.timings,
      });
    }

    const answer = await answerQuestion({
      vaultId,
      question,
      retrieval,
      source: "playground",
      workspaceId: await getWorkspaceId(),
      senderEmail: auth.user.email,
    });

    const grounding =
      body.skipGrounding || answer.noContext
        ? null
        : await checkGrounding({
            question,
            draft: answer.bodyMarkdown,
            chunks: answer.retrieval,
            contextBlock: retrieval.contextBlock,
          });

    const gate = grounding ? await applyGate(grounding) : null;

    return NextResponse.json({
      ok: true,
      question,
      answer: answer.bodyMarkdown,
      noContext: answer.noContext,
      queries: retrieval.queries,
      chunks: retrieval.chunks,
      contextTokens: retrieval.contextTokens,
      grounding,
      gate: gate ? { action: gate.action, rationale: gate.rationale } : null,
      generation: answer.generation,
      timings: retrieval.timings,
    });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
