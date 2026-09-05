"use client";

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";

/**
 * Floating "back to top" control.
 *
 * Appears once the page is scrolled far enough that the header is out of reach.
 * Watches a named scroll container when given one, because the dashboard scrolls
 * an inner element rather than the window — the sidebar stays fixed.
 */
export default function ScrollToTop({
  /** Element id of the scroll container. Falls back to the window. */
  containerId,
  threshold = 400,
}: {
  containerId?: string;
  threshold?: number;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const target: HTMLElement | Window =
      (containerId && document.getElementById(containerId)) || window;

    const read = () =>
      target instanceof Window ? target.scrollY : (target as HTMLElement).scrollTop;

    const onScroll = () => setVisible(read() > threshold);
    onScroll();

    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [containerId, threshold]);

  function toTop() {
    const target: HTMLElement | Window =
      (containerId && document.getElementById(containerId)) || window;
    target.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (!visible) return null;

  return (
    <button
      onClick={toTop}
      aria-label="Back to top"
      title="Back to top"
      className="press animate-fade-in fixed bottom-6 right-6 z-30 flex h-9 w-9 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-muted)] shadow-lg hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
    >
      <ArrowUp size={15} />
    </button>
  );
}
