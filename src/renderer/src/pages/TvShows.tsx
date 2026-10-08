import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Show } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { useProfile } from '../lib/ProfileContext'
import { imageUrl } from '../lib/media'
import PosterCard from '../components/PosterCard'
import SkeletonGrid from '../components/SkeletonGrid'

type SortOption = 'title' | 'yearNewest' | 'yearOldest' | 'rating' | 'recentlyAdded'

export default function TvShows(): JSX.Element {
  const port = usePort()
  const navigate = useNavigate()
  const { activeProfile, profilePin } = useProfile()
  const [shows, setShows] = useState<Show[]>([])
  const [loading, setLoading] = useState(true)
  const [sort, setSort] = useState<SortOption>('title')
  const [genre, setGenre] = useState('')
  const [newSince, setNewSince] = useState<string | null>(null)
  const [unwatchedOnly, setUnwatchedOnly] = useState(false)
  // Finished titles; null when the server is too old to say.
  const [watched, setWatched] = useState<Set<number> | null>(null)

  useEffect(() => {
    window.api.shows.list().then((list) => {
      setShows(list)
      setLoading(false)
    })
    window.api.library.getSeenAt(activeProfile.id, profilePin).then(({ shows: seenAt }) => {
      setNewSince(seenAt)
      window.api.library.markSeen(activeProfile.id, 'show', profilePin)
    })
    window.api.watched
      .set(activeProfile.id, profilePin)
      .then((set) => setWatched(set ? new Set(set.shows) : null))
      .catch(() => setWatched(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const genres = useMemo(() => [...new Set(shows.flatMap((s) => s.genres))].sort(), [shows])

  const visible = useMemo(() => {
    let list = genre ? shows.filter((s) => s.genres.includes(genre)) : shows
    if (unwatchedOnly && watched) list = list.filter((s) => !watched.has(s.id))
    list = [...list]
    switch (sort) {
      case 'yearNewest':
        list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
        break
      case 'yearOldest':
        list.sort((a, b) => (a.year ?? 0) - (b.year ?? 0))
        break
      case 'rating':
        list.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
        break
      case 'recentlyAdded':
        list.sort((a, b) => (b.addedAt > a.addedAt ? 1 : -1))
        break
      default:
        list.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle))
    }
    return list
  }, [shows, sort, genre, unwatchedOnly, watched])

  return (
    <div className="page">
      <div className="page-title-row">
        <h1 className="page-title">
          TV Shows
          {shows.length > 0 && <span className="page-title-count">{shows.length}</span>}
        </h1>
        {shows.length > 0 && (
          <div className="grid-controls">
            <select value={sort} onChange={(e) => setSort(e.target.value as SortOption)}>
              <option value="title">Title A-Z</option>
              <option value="yearNewest">Year (Newest)</option>
              <option value="yearOldest">Year (Oldest)</option>
              <option value="rating">Rating</option>
              <option value="recentlyAdded">Recently Added</option>
            </select>
            {genres.length > 0 && (
              <select value={genre} onChange={(e) => setGenre(e.target.value)}>
                <option value="">All Genres</option>
                {genres.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            )}
            {watched && (
              <label className="grid-controls-checkbox">
                <input type="checkbox" checked={unwatchedOnly} onChange={(e) => setUnwatchedOnly(e.target.checked)} />
                Unwatched
              </label>
            )}
          </div>
        )}
      </div>
      {loading ? (
        <SkeletonGrid />
      ) : shows.length === 0 ? (
        <p className="empty-state-inline">No shows found yet. Add and scan a TV library in Settings.</p>
      ) : visible.length === 0 ? (
        <p className="empty-state-inline">Nothing matches these filters.</p>
      ) : (
        <div className="grid">
          {visible.map((show) => (
            <PosterCard
              key={show.id}
              title={show.title}
              subtitle={show.year ? String(show.year) : null}
              posterUrl={imageUrl(show.posterPath, port)}
              badge={newSince && show.addedAt > newSince ? 'New' : undefined}
              onClick={() => navigate(`/show/${show.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
