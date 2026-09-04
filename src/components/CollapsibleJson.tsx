"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Collapsed JSON dump.
 *
 * Kept out of the way but reachable: the last inbound bug was only diagnosable
 * by seeing that Resend's webhook payload had no `text` field at all, and that
 * meant a database query. Here it is one click.
 */
export default function CollapsibleJson({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);

  let rendered: string;
  try {
    rendered = JSON.stringify(value, null, 2);
  } catch {
    rendered = String(value);
  }

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
      >
        <ChevronDown size={13} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
        {label}
      </button>

      {open && (
        <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-[var(--color-canvas)] p-3 text-[11px] leading-relaxed text-[var(--color-muted)]">
          {rendered}
        </pre>
      )}
    </div>
  );
}
