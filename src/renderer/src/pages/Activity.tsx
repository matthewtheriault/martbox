import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ActivityItem } from '../../../shared/types'
import { useProfile } from '../lib/ProfileContext'
import { usePort } from '../lib/PortContext'
import { imageUrl } from '../lib/media'

export default function Activity(): JSX.Element | null {
  const { activeProfile } = useProfile()
  const port = usePort()
  const navigate = useNavigate()
  const [items, setItems] = useState<ActivityItem[]>([])

  useEffect(() => {
    if (!activeProfile.isAdmin) {
      navigate('/', { replace: true })
      return
    }
    window.api.activity.list().then(setItems)
  }, [activeProfile.isAdmin])

  if (!activeProfile.isAdmin) return null

  return (
    <div className="page">
      <h1 className="page-title">Activity</h1>
      {items.length === 0 ? (
        <p className="empty-state-inline">No activity yet.</p>
      ) : (
        <div className="episode-list">
          {items.map((item) => {
            const fraction = item.durationSeconds ? item.positionSeconds / item.durationSeconds : 0
            return (
              <button
                key={`${item.profileId}-${item.mediaType}-${item.mediaId}`}
                className="episode-row"
                onClick={() => navigate(`/play/${item.mediaType}/${item.mediaId}`)}
              >
                <div className="episode-still">
                  {item.posterPath && <img src={imageUrl(item.posterPath, port)} alt={item.title} />}
                  {fraction > 0 && !item.watched && (
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
                    {item.title}
                    {item.watched && <span className="watched-badge">Watched</span>}
                  </div>
                  <div className="episode-overview">{item.subtitle}</div>
                  <div className="activity-meta">
                    <span
                      className="sidebar-profile-avatar activity-avatar"
                      style={{ background: item.profileAvatarId }}
                    >
                      {item.profileName.charAt(0).toUpperCase()}
                    </span>
                    {item.profileName} · {new Date(item.updatedAt).toLocaleString()}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
