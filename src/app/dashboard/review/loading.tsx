import { SkeletonLine, SkeletonRows } from "@/components/Skeleton";

export default function Loading() {
  return (
    <div>
      <div className="mb-6 space-y-2">
        <SkeletonLine w="180px" h={26} />
        <SkeletonLine w="420px" h={12} />
      </div>
      <SkeletonRows rows={5} />
    </div>
  );
}
