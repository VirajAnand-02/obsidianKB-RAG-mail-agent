import type { EmbeddingProvider, LlmProvider } from "@/lib/env";

// ---------------------------------------------------------------- vault ----

export type VaultStatus = "pending" | "uploading" | "ingesting" | "ready" | "failed";
export type VaultSource = "zip" | "folder" | "git" | "seed";

export interface Vault {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  source: VaultSource;
  archive_path: string | null;
  archive_bytes: number | null;
  status: VaultStatus;
  is_default: boolean;
  stats: VaultStats;
  error: string | null;
  last_ingested_at: string | null;
  created_at: string;
}

export interface VaultStats {
  notes?: number;
  chunks?: number;
  tokens?: number;
  skipped?: number;
  private?: number;
  attachments?: number;
}

/** A markdown file parsed out of an uploaded vault, before chunking. */
export interface ParsedNote {
  path: string;
  title: string;
  body: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  links: string[];
  aliases: string[];
  contentHash: string;
  wordCount: number;
  isPrivate: boolean;
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------- chunks ---

export interface Chunk {
  /** 0-based position within the note. Drives neighbour-window expansion. */
  ordinal: number;
  /** ["Note title", "H1", "H2"] breadcrumb. */
  headingPath: string[];
  content: string;
  tokenCount: number;
  charStart: number;
  charEnd: number;
  contentHash: string;
}

export interface RetrievedChunk {
  chunkId: string;
  noteId: string;
  path: string;
  title: string;
  headingPath: string[];
  content: string;
  ordinal: number;
  tokenCount: number;
  tags: string[];
  noteUpdatedAt: string | null;
  similarity: number | null;
  ftsScore: number | null;
  score: number;
  /** Assigned when the context block is built: C1, C2, ... */
  citationId?: string;
  /** True when pulled in by neighbour expansion rather than matched directly. */
  isNeighbor?: boolean;
  /** Present after a cross-encoder rerank. */
  rerankScore?: number;
}

export interface EmbeddingSpace {
  id: string;
  provider: string;
  model: string;
  dimensions: number;
  doc_prefix: string;
  query_prefix: string;
  is_active: boolean;
}

// ------------------------------------------------------------- retrieval ---

export interface RetrievalOptions {
  vaultId: string;
  query: string;
  topK?: number;
  candidateK?: number;
  minScore?: number;
  hybrid?: boolean;
  neighborWindow?: number;
  queryExpansion?: boolean;
  includePrivate?: boolean;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** The original question plus any generated variants actually searched. */
  queries: string[];
  contextBlock: string;
  contextTokens: number;
  timings: { embedMs: number; searchMs: number; rerankMs: number; totalMs: number };
}

// -------------------------------------------------------------- grounding --

export type GroundingVerdict = "pass" | "review" | "block" | "skipped" | "error";
export type ClaimStatus = "supported" | "partial" | "unsupported" | "contradicted";

export interface GroundingClaim {
  claim: string;
  status: ClaimStatus;
  citedIds: string[];
  supportingIds: string[];
  note?: string;
}

export interface GroundingReport {
  score: number;
  verdict: GroundingVerdict;
  claims: GroundingClaim[];
  unsupportedClaims: string[];
  hallucinationRisk: "low" | "medium" | "high";
  missingCitations: boolean;
  reasoning: string;
  /** Set when the judge itself failed and GROUNDING_FAIL_MODE decided the outcome. */
  failedOpen?: boolean;
}

/** The gate's decision, after thresholds are applied to the judge's score. */
export type GateAction = "send" | "review" | "block";

export interface GateDecision {
  action: GateAction;
  report: GroundingReport;
  rationale: string;
}

// ------------------------------------------------------------------ mail ---

export type DeliveryStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"
  | "blocked"
  | "sending"
  | "sent"
  | "failed";

export interface InboundMessage {
  providerEventId?: string;
  messageId?: string;
  inReplyTo?: string;
  from: { email: string; name?: string };
  to: string;
  subject: string;
  text?: string;
  html?: string;
  receivedAt: string;
  raw?: unknown;
}

export interface AnswerDraft {
  subject: string;
  bodyMarkdown: string;
  retrieval: RetrievedChunk[];
  generation: {
    provider: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs: number;
  };
}

// -------------------------------------------------------------- settings ---

export interface RuntimeConfig {
  llm: {
    provider: LlmProvider;
    model: string;
    temperature: number;
    maxOutputTokens: number;
  };
  embedding: {
    provider: EmbeddingProvider;
    model: string;
    dimensions: number;
    batchSize: number;
    concurrency: number;
    docPrefix: string;
    queryPrefix: string;
  };
  chunking: {
    strategy: "markdown" | "recursive";
    sizeTokens: number;
    overlapTokens: number;
    minTokens: number;
    maxTokens: number;
    prependHeadings: boolean;
    keepCodeBlocks: boolean;
  };
  retrieval: {
    hybrid: boolean;
    rrfK: number;
    candidateK: number;
    topK: number;
    minScore: number;
    neighborWindow: number;
    queryExpansion: boolean;
    queryVariants: number;
    reranker: "none" | "cohere" | "jina";
    rerankerModel: string;
    contextTokenBudget: number;
    efSearch: number;
  };
  grounding: {
    enabled: boolean;
    provider: string;
    model: string;
    autosendThreshold: number;
    reviewThreshold: number;
    requireCitations: boolean;
    failMode: "review" | "block" | "send";
  };
  email: {
    fromEmail: string;
    fromName: string;
    replyTo: string;
    dryRun: boolean;
    allowedSenderDomains: string[];
    rateLimitPerSenderPerDay: number;
  };
}

// ------------------------------------------------------------------ eval ---

export interface EvalCase {
  id: string;
  question: string;
  /** Reference answer. Optional: groundedness works without one. */
  expected?: string;
  /** Note paths that should appear in retrieval, for recall scoring. */
  expectedSources?: string[];
  /** Marks questions the vault genuinely cannot answer. */
  shouldRefuse?: boolean;
  tags?: string[];
}

export interface EvalScores {
  groundedness?: number;
  answerRelevance?: number;
  correctness?: number;
  tone?: number;
  citationValidity?: number;
  contextRecall?: number;
  contextPrecision?: number;
  refusalCorrectness?: number;
}

export interface EvalCaseResult {
  caseId: string;
  repeatIndex: number;
  question: string;
  expected?: string;
  answer: string;
  retrieval: RetrievedChunk[];
  scores: EvalScores;
  judge: Record<string, unknown>;
  overall: number;
  passed: boolean;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}
