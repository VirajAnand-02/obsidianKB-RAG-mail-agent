import { redirect } from "next/navigation";
import { isDemoMode } from "@/lib/auth";
import LoginForm from "@/components/LoginForm";

export const dynamic = "force-dynamic";

/**
 * Sign-in.
 *
 * In demo mode there is no account to sign into, so anyone landing here — from
 * a bookmark, or a stale link — is sent straight to the dashboard rather than
 * shown a form that cannot do anything.
 */
export default function LoginPage() {
  if (isDemoMode()) redirect("/dashboard");
  return <LoginForm />;
}
