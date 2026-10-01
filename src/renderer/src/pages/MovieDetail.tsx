import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Movie, WatchProgress } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { useProfile } from '../lib/ProfileContext'
import { imageUrl, formatRuntime } from '../lib/media'
import MetadataEditor from '../components/MetadataEditor'
import Row from '../components/Row'
import PosterCard from '../components/PosterCard'
import FilePathRow from '../components/FilePathRow'
import CastCrew from '../components/CastCrew'
import WatchlistButton from '../components/WatchlistButton'

export default function MovieDetail(): JSX.Element | null {
  const { id } = useParams()
  const port = usePort()
  const { activeProfile, isHost, profilePin } = useProfile()
  const navigate = useNavigate()
  const [movie, setMovie] = useState<Movie | null>(null)
  const [progress, setProgress] = useState<WatchProgress | null>(null)
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [collection, setCollection] = useState<Movie[]>([])
  const [recommendations, setRecommendations] = useState<Movie[]>([])

  useEffect(() => {
    if (!id) return
    window.api.movies.get(Number(id)).then(setMovie)
    window.api.progress.get(activeProfile.id, 'movie', Number(id), profilePin).then(setProgress)
    window.api.movies.collection(Number(id)).then(setCollection)
    window.api.movies.recommendations(Number(id)).then(setRecommendations)
  }, [id, activeProfile.id])

  if (!movie) return null

  const resumeSeconds = progress && !progress.watched ? progress.positionSeconds : 0

  const removeMovie = async (): Promise<void> => {
    setRemoving(true)
    const result = await window.api.movies.delete(movie.id)
    setRemoving(false)
    if (result.deleted) navigate('/movies')
  }

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
            {movie.genres.length > 0 && <span>{movie.genres.join(', ')}</span>}
          </div>
          <p className="detail-overview">{movie.overview}</p>
          <FilePathRow path={movie.filePath} isHost={isHost} />
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
                  .setWatched(activeProfile.id, 'movie', movie.id, !progress?.watched, profilePin)
                  .then(() =>
                    window.api.progress
                      .get(activeProfile.id, 'movie', movie.id, profilePin)
                      .then(setProgress)
                  )
              }
            >
              {progress?.watched ? 'Mark Unwatched' : 'Mark Watched'}
            </button>
            <button className="btn-secondary" onClick={() => setEditing((v) => !v)}>
              {editing ? 'Close Editor' : 'Edit Metadata'}
            </button>
            <WatchlistButton
              profileId={activeProfile.id}
              pin={profilePin}
              mediaType="movie"
              mediaId={movie.id}
            />
            {isHost && activeProfile.isAdmin && (
              <button className="btn-danger" onClick={removeMovie} disabled={removing}>
                {removing ? 'Removing…' : 'Remove from Library'}
              </button>
            )}
          </div>

          <CastCrew cast={movie.cast} crew={movie.crew} trailerKey={movie.trailerKey} />

          {editing && (
            <MetadataEditor
              title={movie.title}
              year={movie.year}
              overview={movie.overview ?? ''}
              onSearch={(query) => window.api.movies.search(query)}
              onApplyMatch={async (tmdbId) => {
                const updated = await window.api.movies.applyMatch(movie.id, tmdbId)
                setMovie(updated)
              }}
              onManualSave={async (patch) => {
                const updated = await window.api.movies.update(movie.id, patch)
                setMovie(updated)
              }}
              onClose={() => setEditing(false)}
            />
          )}
        </div>
      </div>

      <div className="page-rows">
        {movie.collectionName && (
          <Row title={movie.collectionName}>
            {collection.map((m) => (
              <PosterCard
                key={m.id}
                title={m.title}
                subtitle={m.year ? String(m.year) : null}
                posterUrl={imageUrl(m.posterPath, port)}
                onClick={() => navigate(`/movie/${m.id}`)}
              />
            ))}
          </Row>
        )}

        <Row title="More Like This">
          {recommendations.map((m) => (
            <PosterCard
              key={m.id}
              title={m.title}
              subtitle={m.year ? String(m.year) : null}
              posterUrl={imageUrl(m.posterPath, port)}
              onClick={() => navigate(`/movie/${m.id}`)}
            />
          ))}
        </Row>
      </div>
    </div>
  )
}
