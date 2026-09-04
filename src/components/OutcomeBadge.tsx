import type { TraceOutcome } from "@/lib/traces";

/** Colour per outcome, shared by the trace list and detail views. */
const STYLES: Record<TraceOutcome, string> = {
  sent: "border-[#1f4d2a] bg-[#12261a] text-[var(--color-ok)]",
  "awaiting review": "border-[#5c4a1a] bg-[#241f10] text-[var(--color-warn)]",
  blocked: "border-[#5c2a2a] bg-[#2a1516] text-[var(--color-bad)]",
  rejected: "border-[#5c2a2a] bg-[#2a1516] text-[var(--color-bad)]",
  failed: "border-[#5c2a2a] bg-[#2a1516] text-[var(--color-bad)]",
  ignored: "border-[var(--color-border)] text-[var(--color-muted)]",
  processing: "border-[#5c4a1a] bg-[#241f10] text-[var(--color-warn)]",
};

export default function OutcomeBadge({
  outcome,
  score,
}: {
  outcome: TraceOutcome;
  score?: number | null;
}) {
  return (
    <span className={`badge shrink-0 ${STYLES[outcome]}`}>
      {outcome}
      {typeof score === "number" && ` · ${score.toFixed(2)}`}
    </span>
  );
}
