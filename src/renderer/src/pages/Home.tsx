import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ContinueWatchingItem, Movie, Show, WatchlistItem } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { useProfile } from '../lib/ProfileContext'
import { imageUrl } from '../lib/media'
import Row from '../components/Row'
import PosterCard from '../components/PosterCard'
import Hero from '../components/Hero'

export default function Home(): JSX.Element {
  const port = usePort()
  const { activeProfile, profilePin } = useProfile()
  const navigate = useNavigate()
  const [continueWatching, setContinueWatching] = useState<ContinueWatchingItem[]>([])
  const [movies, setMovies] = useState<Movie[]>([])
  const [shows, setShows] = useState<Show[]>([])
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([])

  const refresh = (): void => {
    window.api.continueWatching.list(activeProfile.id, profilePin).then(setContinueWatching)
    window.api.movies.list().then((m) => setMovies(m.slice(-20).reverse()))
    window.api.shows.list().then((s) => setShows(s.slice(-20).reverse()))
    window.api.watchlist.list(activeProfile.id, profilePin).then(setWatchlist)
  }

  useEffect(refresh, [activeProfile.id])

  const openContinueWatching = (item: ContinueWatchingItem): void => {
    if (item.mediaType === 'movie') navigate(`/play/movie/${item.mediaId}`)
    else navigate(`/play/episode/${item.mediaId}`)
  }

  const hasLibrary = movies.length > 0 || shows.length > 0
  const featured = continueWatching[0] ?? null

  type FeaturedFallback =
    | { kind: 'movie'; data: Movie }
    | { kind: 'show'; data: Show }
    | null

  const featuredFallback: FeaturedFallback = featured
    ? null
    : movies[0]
      ? { kind: 'movie', data: movies[0] }
      : shows[0]
        ? { kind: 'show', data: shows[0] }
        : null

  return (
    <div className="page page-home">
      {!hasLibrary && (
        <div className="empty-state">
          <h1>Welcome to MartBox</h1>
          <p>Add a library in Settings to start scanning your Movies and TV Shows.</p>
          <button className="btn-primary" onClick={() => navigate('/settings')}>
            Go to Settings
          </button>
        </div>
      )}

      {featured && (
        <Hero
          title={featured.title}
          overview={featured.subtitle}
          backdropPath={featured.backdropPath}
          port={port}
          progressFraction={
            featured.durationSeconds ? featured.positionSeconds / featured.durationSeconds : 0
          }
          onPlay={() => openContinueWatching(featured)}
        />
      )}

      {featuredFallback && (
        <Hero
          title={featuredFallback.data.title}
          overview={featuredFallback.data.overview}
          backdropPath={featuredFallback.data.backdropPath}
          port={port}
          onPlay={() =>
            navigate(
              featuredFallback.kind === 'movie'
                ? `/movie/${featuredFallback.data.id}`
                : `/show/${featuredFallback.data.id}`
            )
          }
        />
      )}

      <div className="page-rows">
        {watchlist.length > 0 && (
          <Row title="My Watchlist">
            {watchlist.map((item) => (
              <PosterCard
                key={`${item.mediaType}-${item.mediaId}`}
                title={item.title}
                subtitle={item.year ? String(item.year) : null}
                posterUrl={imageUrl(item.posterPath, port)}
                onClick={() =>
                  navigate(item.mediaType === 'movie' ? `/movie/${item.mediaId}` : `/show/${item.mediaId}`)
                }
              />
            ))}
          </Row>
        )}

        <Row title="Continue Watching">
          {continueWatching.map((item) => (
            <PosterCard
              key={`${item.mediaType}-${item.mediaId}`}
              title={item.title}
              subtitle={item.subtitle}
              posterUrl={imageUrl(item.posterPath, port)}
              progressFraction={
                item.durationSeconds ? item.positionSeconds / item.durationSeconds : 0
              }
              onClick={() => openContinueWatching(item)}
            />
          ))}
        </Row>

        <Row title="Recently Added Movies">
          {movies.map((movie) => (
            <PosterCard
              key={movie.id}
              title={movie.title}
              subtitle={movie.year ? String(movie.year) : null}
              posterUrl={imageUrl(movie.posterPath, port)}
              onClick={() => navigate(`/movie/${movie.id}`)}
            />
          ))}
        </Row>

        <Row title="Recently Added TV Shows">
          {shows.map((show) => (
            <PosterCard
              key={show.id}
              title={show.title}
              subtitle={show.year ? String(show.year) : null}
              posterUrl={imageUrl(show.posterPath, port)}
              onClick={() => navigate(`/show/${show.id}`)}
            />
          ))}
        </Row>
      </div>
    </div>
  )
}
