import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { IptvChannel } from '../../../shared/types'
import PosterCard from '../components/PosterCard'

export default function LiveTv(): JSX.Element {
  const navigate = useNavigate()
  const [channels, setChannels] = useState<IptvChannel[]>([])

  useEffect(() => {
    window.api.iptv.list().then(setChannels)
  }, [])

  return (
    <div className="page">
      <h1 className="page-title">Live TV</h1>
      {channels.length === 0 ? (
        <p className="empty-state-inline">No channels yet. Add an M3U playlist URL in Settings.</p>
      ) : (
        <div className="grid">
          {channels.map((ch) => (
            <PosterCard
              key={ch.id}
              title={ch.name}
              subtitle={ch.nowPlayingTitle}
              posterUrl={ch.logoUrl ?? undefined}
              onClick={() => navigate(`/play/live/${ch.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
