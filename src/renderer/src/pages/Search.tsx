import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { Movie, Show } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { imageUrl } from '../lib/media'
import PosterCard from '../components/PosterCard'
import Row from '../components/Row'

export default function Search(): JSX.Element {
  const [params] = useSearchParams()
  const query = params.get('q') ?? ''
  const port = usePort()
  const navigate = useNavigate()
  const [results, setResults] = useState<{ movies: Movie[]; shows: Show[] } | null>(null)

  useEffect(() => {
    if (!query.trim()) {
      setResults({ movies: [], shows: [] })
      return
    }
    window.api.search.library(query).then(setResults)
  }, [query])

  const noResults = results && results.movies.length === 0 && results.shows.length === 0

  return (
    <div className="page">
      <h1 className="page-title">Search results for &ldquo;{query}&rdquo;</h1>
      {noResults && <p className="empty-state-inline">No matches found.</p>}

      <div className="page-rows">
        <Row title="Movies">
          {results?.movies.map((movie) => (
            <PosterCard
              key={movie.id}
              title={movie.title}
              subtitle={movie.year ? String(movie.year) : null}
              posterUrl={imageUrl(movie.posterPath, port)}
              onClick={() => navigate(`/movie/${movie.id}`)}
            />
          ))}
        </Row>

        <Row title="TV Shows">
          {results?.shows.map((show) => (
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
