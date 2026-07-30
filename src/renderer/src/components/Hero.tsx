import { imageUrl } from '../lib/media'

interface HeroProps {
  title: string
  overview?: string | null
  backdropPath: string | null
  posterPath?: string | null
  meta?: string | null
  port: number
  progressFraction?: number
  onPlay: () => void
  onMoreInfo?: () => void
}

export default function Hero({
  title,
  overview,
  backdropPath,
  meta,
  port,
  progressFraction,
  onPlay,
  onMoreInfo
}: HeroProps): JSX.Element {
  return (
    <section className="hero">
      {backdropPath && (
        <div className="hero-backdrop" style={{ backgroundImage: `url(${imageUrl(backdropPath, port)})` }} />
      )}
      <div className="hero-scrim" />
      <div className="hero-content">
        <div className="hero-eyebrow">{progressFraction ? 'Continue Watching' : 'Featured'}</div>
        <h1 className="hero-title">{title}</h1>
        {meta && <div className="hero-meta">{meta}</div>}
        {overview && <p className="hero-overview">{overview}</p>}
        <div className="hero-actions">
          <button className="btn-primary btn-lg" onClick={onPlay}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M8 5v14l11-7z" />
            </svg>
            {progressFraction ? 'Resume' : 'Play'}
          </button>
          {onMoreInfo && (
            <button className="btn-secondary btn-lg" onClick={onMoreInfo}>
              More Info
            </button>
          )}
        </div>
        {typeof progressFraction === 'number' && progressFraction > 0 && (
          <div className="hero-progress">
            <div className="hero-progress-fill" style={{ width: `${Math.min(progressFraction * 100, 100)}%` }} />
          </div>
        )}
      </div>
    </section>
  )
}
