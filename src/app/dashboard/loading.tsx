import { SkeletonLine, SkeletonRows, SkeletonStats } from "@/components/Skeleton";

export default function Loading() {
  return (
    <div>
      <div className="mb-6 space-y-2">
        <SkeletonLine w="150px" h={26} />
        <SkeletonLine w="400px" h={12} />
      </div>
      <SkeletonStats />
      <div className="mt-8 space-y-3">
        <SkeletonLine w="90px" h={12} />
        <SkeletonRows rows={3} />
      </div>
    </div>
  );
}
