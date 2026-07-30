import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Show } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { imageUrl } from '../lib/media'
import PosterCard from '../components/PosterCard'

export default function TvShows(): JSX.Element {
  const port = usePort()
  const navigate = useNavigate()
  const [shows, setShows] = useState<Show[]>([])

  useEffect(() => {
    window.api.shows.list().then(setShows)
  }, [])

  return (
    <div className="page">
      <h1 className="page-title">TV Shows</h1>
      {shows.length === 0 ? (
        <p className="empty-state-inline">No shows found yet. Add and scan a TV library in Settings.</p>
      ) : (
        <div className="grid">
          {shows.map((show) => (
            <PosterCard
              key={show.id}
              title={show.title}
              subtitle={show.year ? String(show.year) : null}
              posterUrl={imageUrl(show.posterPath, port)}
              onClick={() => navigate(`/show/${show.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
