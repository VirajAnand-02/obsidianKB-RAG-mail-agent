import { SkeletonCard, SkeletonLine } from "@/components/Skeleton";

export default function Loading() {
  return (
    <div>
      <div className="mb-6 space-y-2">
        <SkeletonLine w="110px" h={26} />
        <SkeletonLine w="460px" h={12} />
      </div>
      <div className="mb-3">
        <SkeletonCard lines={1} />
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(220px,300px)_1fr]">
        <SkeletonCard lines={8} />
        <SkeletonCard lines={10} />
      </div>
    </div>
  );
}
