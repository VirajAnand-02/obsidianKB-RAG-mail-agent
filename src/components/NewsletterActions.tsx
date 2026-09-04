"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send, Sparkles } from "lucide-react";

/**
 * Compose or send a newsletter issue.
 *
 * With no `issueId` this drafts a new issue via the cron endpoint; with one it
 * sends that issue after review.
 */
export default function NewsletterActions({
  issueId,
  mode = "compose",
}: {
  issueId?: string;
  mode?: "compose" | "send";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function compose() {
    setBusy(true);
    setMessage("");

    try {
      // Drafting reuses the cron path so the manual and scheduled routes cannot
      // drift apart in behaviour.
      const res = await fetch("/api/newsletter/compose", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not compose an issue.");

      setMessage(json.skipped ?? `Drafted: ${json.title ?? "issue"}`);
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!issueId) return;
    setBusy(true);
    setMessage("");

    try {
      const res = await fetch(`/api/newsletter/${issueId}/send`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Send failed.");

      setMessage(`Sent to ${json.sent}${json.failed ? `, ${json.failed} failed` : ""}.`);
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={mode === "send" ? send : compose}
        disabled={busy}
        className={mode === "send" ? "btn-primary text-xs" : "btn-ghost"}
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : mode === "send" ? (
          <Send size={13} />
        ) : (
          <Sparkles size={14} />
        )}
        {mode === "send" ? "Approve and send" : "Draft an issue now"}
      </button>

      {message && <p className="text-xs text-[var(--color-muted)]">{message}</p>}
    </div>
  );
}
