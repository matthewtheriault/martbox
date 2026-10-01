export default function SkeletonGrid({ count = 12 }: { count?: number }): JSX.Element {
  return (
    <div className="grid" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div className="poster-card poster-card-skeleton" key={i}>
          <div className="poster-card-image skeleton-shimmer" />
          <div className="skeleton-line skeleton-shimmer" />
        </div>
      ))}
    </div>
  )
}
