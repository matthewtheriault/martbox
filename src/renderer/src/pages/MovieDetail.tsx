import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Movie, WatchProgress } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { imageUrl, formatRuntime } from '../lib/media'

export default function MovieDetail(): JSX.Element | null {
  const { id } = useParams()
  const port = usePort()
  const navigate = useNavigate()
  const [movie, setMovie] = useState<Movie | null>(null)
  const [progress, setProgress] = useState<WatchProgress | null>(null)

  useEffect(() => {
    if (!id) return
    window.api.movies.get(Number(id)).then(setMovie)
    window.api.progress.get('movie', Number(id)).then(setProgress)
  }, [id])

  if (!movie) return null

  const resumeSeconds = progress && !progress.watched ? progress.positionSeconds : 0

  return (
    <div className="detail-page">
      {movie.backdropPath && (
        <div
          className="detail-backdrop"
          style={{ backgroundImage: `url(${imageUrl(movie.backdropPath, port)})` }}
        />
      )}
      <div className="detail-content">
        <div className="detail-poster">
          {movie.posterPath && <img src={imageUrl(movie.posterPath, port)} alt={movie.title} />}
        </div>
        <div className="detail-info">
          <h1>{movie.title}</h1>
          <div className="detail-meta">
            {movie.year && <span>{movie.year}</span>}
            {movie.runtimeMinutes && <span>{formatRuntime(movie.runtimeMinutes)}</span>}
            {movie.rating && <span>★ {movie.rating.toFixed(1)}</span>}
          </div>
          <p className="detail-overview">{movie.overview}</p>
          <div className="detail-actions">
            <button
              className="btn-primary"
              onClick={() => navigate(`/play/movie/${movie.id}`)}
            >
              {resumeSeconds > 0 ? 'Resume' : 'Play'}
            </button>
            <button
              className="btn-secondary"
              onClick={() =>
                window.api.progress
                  .setWatched('movie', movie.id, !progress?.watched)
                  .then(() => window.api.progress.get('movie', movie.id).then(setProgress))
              }
            >
              {progress?.watched ? 'Mark Unwatched' : 'Mark Watched'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
