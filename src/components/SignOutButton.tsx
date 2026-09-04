"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

/** Clears the session cookie and returns to the login page. */
export default function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/login");
    router.refresh();
  }

  return (
    <button
      onClick={signOut}
      disabled={busy}
      className="flex items-center gap-2 text-xs text-[var(--color-muted)] transition-colors hover:text-[var(--color-ink)]"
    >
      <LogOut size={13} />
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
