import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Activity,
  BookOpen,
  Inbox,
  LayoutDashboard,
  MessageSquare,
  Settings,
} from "lucide-react";

import { getAdmin, isDevAuthBypassEnabled } from "@/lib/auth";
import SignOutButton from "@/components/SignOutButton";
import { isDatabaseConfigured } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { getRuntimeConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/vault", label: "Vault", icon: BookOpen },
  { href: "/dashboard/traces", label: "Traces", icon: Activity },
  { href: "/dashboard/review", label: "Review queue", icon: Inbox },
  { href: "/dashboard/playground", label: "Playground", icon: MessageSquare },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getAdmin();
  if (!user) redirect("/login?next=/dashboard");

  const bypassed = isDevAuthBypassEnabled();
  const runtimeConfig = await getRuntimeConfig();

  // Checked after the session, so the setup notice (which names environment
  // variables) is only visible to a signed-in admin.
  if (!isDatabaseConfigured()) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-24">
        <div className="card">
          <h1 className="text-lg font-semibold">Finish setup first</h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Supabase is not configured yet. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
            <code>SUPABASE_SECRET_KEY</code> in <code>.env</code>, then run{" "}
            <code className="text-[var(--color-ink)]">npm run db:init</code>.
          </p>
          <Link href="/" className="btn-ghost mt-5">
            Back to setup
          </Link>
        </div>
      </main>
    );
  }


  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] p-3 md:block">
        <Link href="/" className="mb-6 flex items-center gap-2 px-2">
          <span className="h-2 w-2 rounded-full bg-[var(--color-accent)]" />
          <span className="font-semibold">Obsi-Relay</span>
        </Link>

        <nav className="space-y-0.5">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="nav-item"
            >
              <Icon size={16} />
              {label}
            </Link>
          ))}
        </nav>

        <div className="mt-6 border-t border-[var(--color-border)] pt-4">
          {runtimeConfig.email.dryRun && (
            <div className="callout callout-warn mb-3">
              Dry-run mode — email is rendered but never delivered.
            </div>
          )}

          {bypassed && (
            <div className="callout callout-bad mb-3">
              Sign-in bypassed (development). Set <code>DEV_AUTH_BYPASS=false</code> to test the
              real login.
            </div>
          )}

          <div className="flex items-center justify-between gap-2 px-2.5">
            <p className="truncate text-xs text-[var(--color-muted)]">{user.email}</p>
            {!bypassed && <SignOutButton />}
          </div>
        </div>
      </aside>

      <div className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
      </div>
    </div>
  );
}
