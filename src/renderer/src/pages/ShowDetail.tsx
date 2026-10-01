import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Episode, Show, WatchProgress } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { useProfile } from '../lib/ProfileContext'
import { imageUrl } from '../lib/media'
import MetadataEditor from '../components/MetadataEditor'
import Row from '../components/Row'
import PosterCard from '../components/PosterCard'
import FilePathRow from '../components/FilePathRow'
import CastCrew from '../components/CastCrew'
import WatchlistButton from '../components/WatchlistButton'

export default function ShowDetail(): JSX.Element | null {
  const { id } = useParams()
  const port = usePort()
  const { activeProfile, isHost, profilePin } = useProfile()
  const navigate = useNavigate()
  const [show, setShow] = useState<Show | null>(null)
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [progressByEpisode, setProgressByEpisode] = useState<Record<number, WatchProgress | null>>(
    {}
  )
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [merging, setMerging] = useState(false)
  const [mergeQuery, setMergeQuery] = useState('')
  const [mergeResults, setMergeResults] = useState<Show[] | null>(null)
  const [mergingId, setMergingId] = useState<number | null>(null)
  const [removing, setRemoving] = useState(false)
  const [recommendations, setRecommendations] = useState<Show[]>([])

  const loadEpisodes = (showId: number): void => {
    window.api.shows.episodes(showId).then(async (eps: Episode[]) => {
      setEpisodes(eps)
      if (eps.length > 0) setSelectedSeason((prev) => prev ?? eps[0].seasonNumber)
      const entries = await Promise.all(
        eps.map(
          async (ep: Episode) =>
            [
              ep.id,
              await window.api.progress.get(activeProfile.id, 'episode', ep.id, profilePin)
            ] as const
        )
      )
      setProgressByEpisode(Object.fromEntries(entries))
    })
  }

  useEffect(() => {
    if (!id) return
    window.api.shows.get(Number(id)).then(setShow)
    loadEpisodes(Number(id))
    window.api.shows.recommendations(Number(id)).then(setRecommendations)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, activeProfile.id])

  const searchShowsToMerge = async (): Promise<void> => {
    if (!show) return
    const all = await window.api.shows.list()
    const q = mergeQuery.trim().toLowerCase()
    setMergeResults(
      all.filter((s) => s.id !== show.id && (!q || s.title.toLowerCase().includes(q)))
    )
  }

  const mergeInto = async (sourceId: number): Promise<void> => {
    if (!show) return
    setMergingId(sourceId)
    const updated = await window.api.shows.merge(show.id, [sourceId])
    setShow(updated)
    loadEpisodes(show.id)
    setMergingId(null)
    setMerging(false)
    setMergeResults(null)
    setMergeQuery('')
  }

  const seasons = useMemo(
    () => [...new Set(episodes.map((e) => e.seasonNumber))].sort((a, b) => a - b),
    [episodes]
  )

  const visibleEpisodes = episodes.filter((e) => e.seasonNumber === selectedSeason)

  const playNext = (): void => {
    window.api.shows.nextEpisode(activeProfile.id, Number(id)).then((ep) => {
      if (ep) navigate(`/play/episode/${ep.id}`)
    })
  }

  const removeShow = async (): Promise<void> => {
    if (!show) return
    setRemoving(true)
    const result = await window.api.shows.delete(show.id)
    setRemoving(false)
    if (result.deleted) navigate('/tv')
  }

  if (!show) return null

  return (
    <div className="detail-page">
      {show.backdropPath && (
        <div
          className="detail-backdrop"
          style={{ backgroundImage: `url(${imageUrl(show.backdropPath, port)})` }}
        />
      )}
      <div className="detail-content">
        <div className="detail-poster">
          {show.posterPath && <img src={imageUrl(show.posterPath, port)} alt={show.title} />}
        </div>
        <div className="detail-info">
          <h1>{show.title}</h1>
          <div className="detail-meta">
            {show.year && <span>{show.year}</span>}
            {show.rating && <span>★ {show.rating.toFixed(1)}</span>}
            {show.genres.length > 0 && <span>{show.genres.join(', ')}</span>}
          </div>
          <p className="detail-overview">{show.overview}</p>
          <FilePathRow path={show.folderPath} isHost={isHost} />
          <div className="detail-actions">
            <button className="btn-primary" onClick={playNext}>
              Play Next Episode
            </button>
            <button
              className="btn-secondary"
              onClick={() => {
                setEditing((v) => !v)
                setMerging(false)
              }}
            >
              {editing ? 'Close Editor' : 'Edit Metadata'}
            </button>
            <button
              className="btn-secondary"
              onClick={() => {
                setMerging((v) => !v)
                setEditing(false)
                setMergeResults(null)
                setMergeQuery('')
              }}
            >
              {merging ? 'Close Merge' : 'Merge with Another Show'}
            </button>
            <WatchlistButton
              profileId={activeProfile.id}
              pin={profilePin}
              mediaType="show"
              mediaId={show.id}
            />
            {isHost && activeProfile.isAdmin && (
              <button className="btn-danger" onClick={removeShow} disabled={removing}>
                {removing ? 'Removing…' : 'Remove from Library'}
              </button>
            )}
          </div>

          <CastCrew cast={show.cast} crew={show.crew} trailerKey={show.trailerKey} />

          {editing && (
            <MetadataEditor
              title={show.title}
              year={show.year}
              overview={show.overview ?? ''}
              onSearch={(query) => window.api.shows.search(query)}
              onApplyMatch={async (tmdbId) => {
                const updated = await window.api.shows.applyMatch(show.id, tmdbId)
                setShow(updated)
              }}
              onManualSave={async (patch) => {
                const updated = await window.api.shows.update(show.id, patch)
                setShow(updated)
              }}
              onClose={() => setEditing(false)}
            />
          )}

          {merging && (
            <div className="metadata-editor">
              <p className="settings-hint">
                Find the other, incorrectly-separate entry for this show. Its episodes will move
                here and it will be removed.
              </p>
              <div className="settings-row">
                <input
                  type="text"
                  value={mergeQuery}
                  onChange={(e) => setMergeQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && searchShowsToMerge()}
                  placeholder="Search shows…"
                  autoFocus
                />
                <button className="btn-primary" onClick={searchShowsToMerge}>
                  Search
                </button>
              </div>
              {mergeResults && (
                <ul className="library-list">
                  {mergeResults.length === 0 && <p className="settings-hint">No matches.</p>}
                  {mergeResults.map((s) => (
                    <li key={s.id} className="library-item">
                      <div className="library-name">
                        {s.title} <span className="library-type">{s.year ?? ''}</span>
                      </div>
                      <div className="library-actions">
                        <button
                          className="btn-primary"
                          onClick={() => mergeInto(s.id)}
                          disabled={mergingId !== null}
                        >
                          {mergingId === s.id ? 'Merging…' : 'Merge Into This Show'}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="season-tabs">
        {seasons.map((s) => (
          <button
            key={s}
            className={s === selectedSeason ? 'season-tab active' : 'season-tab'}
            onClick={() => setSelectedSeason(s)}
          >
            Season {s}
          </button>
        ))}
      </div>

      <div className="episode-list">
        {visibleEpisodes.map((ep) => {
          const progress = progressByEpisode[ep.id]
          const fraction =
            progress && progress.durationSeconds
              ? progress.positionSeconds / progress.durationSeconds
              : 0
          return (
            <div
              key={ep.id}
              className="episode-row"
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/play/episode/${ep.id}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') navigate(`/play/episode/${ep.id}`)
              }}
            >
              <div className="episode-still">
                {ep.stillPath && <img src={imageUrl(ep.stillPath, port)} alt={ep.title} />}
                {fraction > 0 && (
                  <div className="poster-card-progress">
                    <div
                      className="poster-card-progress-fill"
                      style={{ width: `${Math.min(fraction * 100, 100)}%` }}
                    />
                  </div>
                )}
              </div>
              <div className="episode-info">
                <div className="episode-title">
                  {ep.episodeNumber}. {ep.title}
                  {progress?.watched && <span className="watched-badge">Watched</span>}
                </div>
                {ep.overview && <div className="episode-overview">{ep.overview}</div>}
                <FilePathRow path={ep.filePath} isHost={isHost} />
              </div>
            </div>
          )
        })}
      </div>

      <div className="page-rows">
        <Row title="More Like This">
          {recommendations.map((s) => (
            <PosterCard
              key={s.id}
              title={s.title}
              subtitle={s.year ? String(s.year) : null}
              posterUrl={imageUrl(s.posterPath, port)}
              onClick={() => navigate(`/show/${s.id}`)}
            />
          ))}
        </Row>
      </div>
    </div>
  )
}
