import { SkeletonCard, SkeletonLine } from "@/components/Skeleton";

export default function Loading() {
  return (
    <div>
      <div className="mb-6 space-y-2">
        <SkeletonLine w="120px" h={26} />
        <SkeletonLine w="400px" h={12} />
      </div>
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} lines={4} />
        ))}
      </div>
    </div>
  );
}
