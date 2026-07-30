export interface SkeletonProps {
  variant?: "text" | "title" | "block";
  /** 可选宽度，如 "40%" 或 "16rem"。 */
  width?: string;
  lines?: number;
}

/** 稳定的内容骨架，不用整页转圈。 */
export function Skeleton({ variant = "text", width, lines = 1 }: SkeletonProps) {
  if (variant === "block") {
    return <div className="skeleton skeleton--block" style={width ? { width } : undefined} aria-hidden="true" />;
  }
  return (
    <div className="skeleton-group" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          className={`skeleton ${variant === "title" ? "skeleton--title" : "skeleton--text"}`}
          style={width ? { width } : undefined}
        />
      ))}
    </div>
  );
}
