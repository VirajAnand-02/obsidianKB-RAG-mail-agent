import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { getTrace } from "@/lib/traces";
import LiveTrace from "@/components/LiveTrace";

export const dynamic = "force-dynamic";

/**
 * Trace detail.
 *
 * Rendered on the server for the first paint, then handed to a client component
 * that keeps it current while the pipeline is still running.
 */
export default async function TraceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const trace = await getTrace(id);
  if (!trace) notFound();

  return (
    <>
      <Link
        href="/dashboard/traces"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-ink)]"
      >
        <ArrowLeft size={14} /> All traces
      </Link>

      <LiveTrace initial={trace} />
    </>
  );
}
