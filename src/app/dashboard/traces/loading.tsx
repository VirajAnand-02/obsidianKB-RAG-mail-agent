import { SkeletonLine, SkeletonRows } from "@/components/Skeleton";

export default function Loading() {
  return (
    <div>
      <div className="mb-6 space-y-2">
        <SkeletonLine w="140px" h={26} />
        <SkeletonLine w="380px" h={12} />
      </div>
      <div className="mb-4 flex gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonLine key={i} w="72px" h={20} />
        ))}
      </div>
      <SkeletonRows rows={8} />
    </div>
  );
}
