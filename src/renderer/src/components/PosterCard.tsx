interface PosterCardProps {
  title: string
  subtitle?: string | null
  posterUrl?: string
  progressFraction?: number
  onClick: () => void
}

export default function PosterCard({
  title,
  subtitle,
  posterUrl,
  progressFraction,
  onClick
}: PosterCardProps): JSX.Element {
  return (
    <button className="poster-card" onClick={onClick} title={title}>
      <div className="poster-card-image">
        {posterUrl ? (
          <img src={posterUrl} alt={title} loading="lazy" />
        ) : (
          <div className="poster-card-placeholder">{title}</div>
        )}
        <div className="poster-card-scrim">
          <span className="poster-card-play">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </div>
        {typeof progressFraction === 'number' && progressFraction > 0 && (
          <div className="poster-card-progress">
            <div
              className="poster-card-progress-fill"
              style={{ width: `${Math.min(progressFraction * 100, 100)}%` }}
            />
          </div>
        )}
      </div>
      <div className="poster-card-title">{title}</div>
      {subtitle && <div className="poster-card-subtitle">{subtitle}</div>}
    </button>
  )
}
