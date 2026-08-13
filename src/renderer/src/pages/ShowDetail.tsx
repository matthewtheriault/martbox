import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Episode, Show, WatchProgress } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { useProfile } from '../lib/ProfileContext'
import { imageUrl } from '../lib/media'

export default function ShowDetail(): JSX.Element | null {
  const { id } = useParams()
  const port = usePort()
  const { activeProfile } = useProfile()
  const navigate = useNavigate()
  const [show, setShow] = useState<Show | null>(null)
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [progressByEpisode, setProgressByEpisode] = useState<Record<number, WatchProgress | null>>(
    {}
  )
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null)

  useEffect(() => {
    if (!id) return
    window.api.shows.get(Number(id)).then(setShow)
    window.api.shows.episodes(Number(id)).then(async (eps: Episode[]) => {
      setEpisodes(eps)
      if (eps.length > 0) setSelectedSeason(eps[0].seasonNumber)
      const entries = await Promise.all(
        eps.map(
          async (ep: Episode) =>
            [ep.id, await window.api.progress.get(activeProfile.id, 'episode', ep.id)] as const
        )
      )
      setProgressByEpisode(Object.fromEntries(entries))
    })
  }, [id, activeProfile.id])

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
          </div>
          <p className="detail-overview">{show.overview}</p>
          <div className="detail-actions">
            <button className="btn-primary" onClick={playNext}>
              Play Next Episode
            </button>
          </div>
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
            <button
              key={ep.id}
              className="episode-row"
              onClick={() => navigate(`/play/episode/${ep.id}`)}
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
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
