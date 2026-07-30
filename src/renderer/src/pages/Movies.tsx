import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Movie } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { imageUrl } from '../lib/media'
import PosterCard from '../components/PosterCard'

export default function Movies(): JSX.Element {
  const port = usePort()
  const navigate = useNavigate()
  const [movies, setMovies] = useState<Movie[]>([])

  useEffect(() => {
    window.api.movies.list().then(setMovies)
  }, [])

  return (
    <div className="page">
      <h1 className="page-title">Movies</h1>
      {movies.length === 0 ? (
        <p className="empty-state-inline">No movies found yet. Add and scan a Movies library in Settings.</p>
      ) : (
        <div className="grid">
          {movies.map((movie) => (
            <PosterCard
              key={movie.id}
              title={movie.title}
              subtitle={movie.year ? String(movie.year) : null}
              posterUrl={imageUrl(movie.posterPath, port)}
              onClick={() => navigate(`/movie/${movie.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
