import { supabaseAdmin } from "@/lib/supabase/admin";
import { errorMessage } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Unsubscribe landing page for the link in the newsletter footer.
 *
 * Acts on load rather than asking for a confirming click: an unsubscribe that
 * needs extra steps gets reported as spam instead.
 */
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  let state: "missing" | "done" | "already" | "error" = "missing";
  let detail = "";

  if (token) {
    try {
      const { data, error } = await supabaseAdmin().rpc("unsubscribe_by_token", {
        p_token: token,
      });
      if (error) throw new Error(error.message);
      state = data ? "done" : "already";
    } catch (e) {
      state = "error";
      detail = errorMessage(e);
    }
  }

  const copy = {
    missing: {
      title: "Missing unsubscribe link",
      body: "This link is incomplete. Use the unsubscribe link at the bottom of the email.",
    },
    done: {
      title: "Unsubscribed",
      body: "You will not receive any more issues. Nothing else is needed.",
    },
    already: {
      title: "Already unsubscribed",
      body: "This address is not on the list, so there is nothing to do.",
    },
    error: { title: "Something went wrong", body: detail },
  }[state];

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="card text-center">
        <h1 className="text-lg font-semibold">{copy.title}</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">{copy.body}</p>
      </div>
    </main>
  );
}
