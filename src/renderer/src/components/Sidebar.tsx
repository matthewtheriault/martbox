import { useEffect, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useProfile } from '../lib/ProfileContext'

const icons = {
  home: (
    <path d="M3 11.5 12 4l9 7.5M5.5 10v9a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1v-9" />
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M3 15h18M8 4v16M16 4v16" />
    </>
  ),
  tv: (
    <>
      <rect x="3" y="5" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 18v3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3.9a7.7 7.7 0 0 0-2.6-1.5L14 2h-4l-.5 2.5a7.7 7.7 0 0 0-2.6 1.5l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-.9c.77.65 1.65 1.16 2.6 1.5L10 22h4l.5-2.5a7.7 7.7 0 0 0 2.6-1.5l2.3.9 2-3.4-2-1.5Z" />
    </>
  ),
  activity: (
    <>
      <path d="M3 12h4l2-7 6 14 2-7h4" />
    </>
  ),
  live: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="m8 2 4 4 4-4" />
    </>
  ),
  requests: (
    <>
      <path d="M12 5v14M5 12h14" />
      <rect x="3" y="3" width="18" height="18" rx="4" />
    </>
  ),
  dashboard: (
    <>
      <path d="M4 15a8 8 0 1 1 16 0" />
      <path d="m12 15 4-5" />
      <path d="M4 19h16" />
    </>
  )
}

function Icon({ name }: { name: keyof typeof icons }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {icons[name]}
    </svg>
  )
}

export default function Sidebar(): JSX.Element {
  const { activeProfile, switchProfile, isHost } = useProfile()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [pendingRequests, setPendingRequests] = useState(0)

  const runSearch = (): void => {
    const trimmed = query.trim()
    if (trimmed) navigate(`/search?q=${encodeURIComponent(trimmed)}`)
  }

  // New requests waiting for the admin, shown on the Dashboard link.
  useEffect(() => {
    if (!activeProfile.isAdmin || !isHost) return
    const load = (): void => {
      window.api.requests
        .pendingCount(activeProfile.id)
        .then(setPendingRequests)
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [activeProfile.id, activeProfile.isAdmin, isHost])

  useEffect(() => {
    window.api.updates
      .getStatus()
      .then((status) => setUpdateAvailable(status.state === 'ready'))
      .catch(() => {})
    return window.api.updates.onStatus((status) => setUpdateAvailable(status.state === 'ready'))
  }, [])

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark" />
        <span className="sidebar-brand-text">martbox</span>
      </div>
      <div className="sidebar-search">
        <Icon name="search" />
        <input
          type="text"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runSearch()}
        />
      </div>
      <nav className="sidebar-nav">
        <NavLink to="/" end className="sidebar-link">
          <Icon name="home" />
          <span>Home</span>
        </NavLink>
        <NavLink to="/movies" className="sidebar-link">
          <Icon name="film" />
          <span>Movies</span>
        </NavLink>
        <NavLink to="/tv" className="sidebar-link">
          <Icon name="tv" />
          <span>TV Shows</span>
        </NavLink>
        {activeProfile.isAdmin && (
          <NavLink to="/activity" className="sidebar-link">
            <Icon name="activity" />
            <span>Activity</span>
          </NavLink>
        )}
        <NavLink to="/live" className="sidebar-link">
          <Icon name="live" />
          <span>Live</span>
        </NavLink>
        <NavLink to="/requests" className="sidebar-link">
          <Icon name="requests" />
          <span>Requests</span>
        </NavLink>
        {activeProfile.isAdmin && isHost && (
          <NavLink to="/dashboard" className="sidebar-link">
            <Icon name="dashboard" />
            <span>Dashboard</span>
            {pendingRequests > 0 && <span className="sidebar-count">{pendingRequests}</span>}
          </NavLink>
        )}
      </nav>
      <button className="sidebar-profile-badge" onClick={switchProfile}>
        <span className="sidebar-profile-avatar" style={{ background: activeProfile.avatarId }}>
          {activeProfile.name.charAt(0).toUpperCase()}
        </span>
        <span className="sidebar-profile-name">{activeProfile.name}</span>
      </button>
      <NavLink to="/settings" className="sidebar-link sidebar-link-settings">
        <Icon name="settings" />
        <span>Settings</span>
        {updateAvailable && <span className="sidebar-update-dot" title="Update ready — restart to install" />}
      </NavLink>
    </aside>
  )
}
