"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Sidebar link that highlights the section you are in.
 *
 * `/dashboard` is matched exactly; everything else matches its subtree, so a
 * trace detail page still shows Traces as active.
 */
export default function NavLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const active = href === "/dashboard" ? pathname === href : pathname.startsWith(href);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`nav-item press ${active ? "nav-item-active" : ""}`}
    >
      {children}
      {label}
    </Link>
  );
}
