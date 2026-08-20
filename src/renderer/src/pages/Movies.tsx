import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Movie } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { useProfile } from '../lib/ProfileContext'
import { imageUrl } from '../lib/media'
import PosterCard from '../components/PosterCard'
import SkeletonGrid from '../components/SkeletonGrid'

type SortOption = 'title' | 'yearNewest' | 'yearOldest' | 'rating' | 'recentlyAdded'

export default function Movies(): JSX.Element {
  const port = usePort()
  const navigate = useNavigate()
  const { activeProfile, profilePin } = useProfile()
  const [movies, setMovies] = useState<Movie[]>([])
  const [loading, setLoading] = useState(true)
  const [sort, setSort] = useState<SortOption>('title')
  const [genre, setGenre] = useState('')
  const [newSince, setNewSince] = useState<string | null>(null)

  useEffect(() => {
    window.api.movies.list().then((list) => {
      setMovies(list)
      setLoading(false)
    })
    // Read the previous "seen" timestamp first (for badges on this visit),
    // then advance it — so returning items still show "New" for this visit
    // but won't on the next one.
    window.api.library.getSeenAt(activeProfile.id, profilePin).then(({ movies: seenAt }) => {
      setNewSince(seenAt)
      window.api.library.markSeen(activeProfile.id, 'movie', profilePin)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const genres = useMemo(
    () => [...new Set(movies.flatMap((m) => m.genres))].sort(),
    [movies]
  )

  const visible = useMemo(() => {
    let list = genre ? movies.filter((m) => m.genres.includes(genre)) : movies
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
  }, [movies, sort, genre])

  return (
    <div className="page">
      <div className="page-title-row">
        <h1 className="page-title">
          Movies
          {movies.length > 0 && <span className="page-title-count">{movies.length}</span>}
        </h1>
        {movies.length > 0 && (
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
          </div>
        )}
      </div>
      {loading ? (
        <SkeletonGrid />
      ) : movies.length === 0 ? (
        <p className="empty-state-inline">No movies found yet. Add and scan a Movies library in Settings.</p>
      ) : (
        <div className="grid">
          {visible.map((movie) => (
            <PosterCard
              key={movie.id}
              title={movie.title}
              subtitle={movie.year ? String(movie.year) : null}
              posterUrl={imageUrl(movie.posterPath, port)}
              badge={newSince && movie.addedAt > newSince ? 'New' : undefined}
              onClick={() => navigate(`/movie/${movie.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
