import Link from "next/link";
import { redirect } from "next/navigation";
import {
  BookOpen,
  FlaskConical,
  Inbox,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Settings,
} from "lucide-react";

import { getAdmin } from "@/lib/auth";
import { isDatabaseConfigured } from "@/lib/supabase/admin";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/vault", label: "Vault", icon: BookOpen },
  { href: "/dashboard/review", label: "Review queue", icon: Inbox },
  { href: "/dashboard/playground", label: "Playground", icon: MessageSquare },
  { href: "/dashboard/newsletters", label: "Newsletters", icon: Mail },
  { href: "/dashboard/evals", label: "Evaluations", icon: FlaskConical },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Before Supabase exists there is no sign-in to redirect to, so say what is
  // missing rather than bouncing the user into a login that cannot work.
  if (!isDatabaseConfigured()) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-24">
        <div className="card">
          <h1 className="text-lg font-semibold">Finish setup first</h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Supabase is not configured yet. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
            <code>SUPABASE_SERVICE_ROLE_KEY</code> in <code>.env</code>, then run{" "}
            <code className="text-[var(--color-ink)]">npm run db:init</code>.
          </p>
          <Link href="/" className="btn-ghost mt-5">
            Back to setup
          </Link>
        </div>
      </main>
    );
  }

  const user = await getAdmin();
  if (!user) redirect("/login?next=/dashboard");

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] p-4 md:block">
        <Link href="/" className="mb-6 flex items-center gap-2 px-2">
          <span className="h-2 w-2 rounded-full bg-[var(--color-accent)]" />
          <span className="font-semibold">Obsi-Relay</span>
        </Link>

        <nav className="space-y-0.5">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
            >
              <Icon size={16} />
              {label}
            </Link>
          ))}
        </nav>

        <div className="mt-6 border-t border-[var(--color-border)] pt-4">
          {env.MAIL_DRY_RUN && (
            <div className="mb-3 rounded-lg border border-[#5c4a1a] bg-[#241f10] px-2.5 py-2 text-xs text-[var(--color-warn)]">
              Dry-run mode — email is rendered but never delivered.
            </div>
          )}
          <p className="truncate px-2.5 text-xs text-[var(--color-muted)]">{user.email}</p>
        </div>
      </aside>

      <div className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
      </div>
    </div>
  );
}
