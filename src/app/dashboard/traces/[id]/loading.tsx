import { SkeletonCard, SkeletonLine } from "@/components/Skeleton";

export default function Loading() {
  return (
    <div>
      <SkeletonLine w="90px" h={12} />
      <div className="mb-6 mt-5 space-y-2">
        <SkeletonLine w="320px" h={22} />
        <SkeletonLine w="440px" h={12} />
      </div>
      <div className="space-y-4 border-l border-[var(--color-border)] pl-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} lines={i === 1 ? 5 : 3} />
        ))}
      </div>
    </div>
  );
}
