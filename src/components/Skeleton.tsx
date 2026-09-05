/**
 * Loading placeholders.
 *
 * Shaped like the content they stand in for, so the layout does not jump when
 * the real data lands. A spinner in the middle of an empty page tells you
 * something is happening; a skeleton tells you what is coming.
 */

export function SkeletonLine({ w = "100%", h = 12 }: { w?: string; h?: number }) {
  return <div className="skeleton" style={{ width: w, height: h }} />;
}

/** Rows for a list view, matching the divided-card layout used across the app. */
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="card divide-y divide-[var(--color-border-soft)] p-0">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-5 py-3.5">
          <div className="min-w-0 flex-1 space-y-2">
            <SkeletonLine w={`${45 + ((i * 13) % 35)}%`} h={12} />
            <SkeletonLine w={`${25 + ((i * 17) % 40)}%`} h={10} />
          </div>
          <SkeletonLine w="52px" h={18} />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card space-y-2.5">
      <SkeletonLine w="35%" h={14} />
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine key={i} w={`${70 + ((i * 11) % 28)}%`} h={11} />
      ))}
    </div>
  );
}

export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card space-y-2.5">
          <SkeletonLine w="55%" h={10} />
          <SkeletonLine w="35%" h={22} />
        </div>
      ))}
    </div>
  );
}
