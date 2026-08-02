import { NavLink } from 'react-router-dom'

const icons = {
  home: (
    <path d="M3 11.5 12 4l9 7.5M5.5 10v9a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1v-9" />
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
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark" />
        <span className="sidebar-brand-text">martbox</span>
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
      </nav>
      <NavLink to="/settings" className="sidebar-link sidebar-link-settings">
        <Icon name="settings" />
        <span>Settings</span>
      </NavLink>
    </aside>
  )
}
