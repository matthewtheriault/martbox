import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { Movie, Show } from '../../../shared/types'
import { useProfile } from '../lib/ProfileContext'

// ⌘K / Ctrl+K (or /): one box to find a title or jump anywhere. Also owns
// the app-wide shortcuts (⌘1–7, ⌘,) and the shortcut list (?).

const isMac = navigator.platform.toLowerCase().includes('mac')
const MOD = isMac ? '⌘' : 'Ctrl+'

interface Item {
  key: string
  label: string
  hint?: string
  run: () => void
}

interface Page {
  label: string
  path: string
  shortcut?: string
  adminOnly?: boolean
}

const PAGES: Page[] = [
  { label: 'Home', path: '/', shortcut: '1' },
  { label: 'Movies', path: '/movies', shortcut: '2' },
  { label: 'TV Shows', path: '/tv', shortcut: '3' },
  { label: 'Collections', path: '/collections', shortcut: '4' },
  { label: 'Live', path: '/live', shortcut: '5' },
  { label: 'Requests', path: '/requests', shortcut: '6' },
  { label: 'Activity', path: '/activity', shortcut: '7' },
  { label: 'Year in Review', path: '/year' },
  { label: 'Dashboard', path: '/dashboard', adminOnly: true },
  { label: 'Settings', path: '/settings', shortcut: ',' }
]

const SHORTCUTS: [string, string][] = [
  [`${MOD}K or /`, 'Search and go anywhere'],
  [`${MOD}1 – ${MOD}7`, 'Home, Movies, TV Shows, Collections, Live, Requests, Activity'],
  [`${MOD},`, 'Settings'],
  [`${MOD}[  ${MOD}]`, 'Back, forward'],
  ['?', 'This list'],
  ['Space or K', 'Play / pause (player)'],
  ['← →  or  J L', 'Back / forward 10 seconds (player)'],
  ['↑ ↓', 'Volume (player)'],
  ['M', 'Mute (player)'],
  ['F', 'Full screen (player)'],
  ['S', 'Skip intro (player)'],
  ['N', 'Next episode (player)'],
  ['Esc', 'Leave the player']
]

function typingInField(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

export default function CommandPalette(): JSX.Element | null {
  const navigate = useNavigate()
  const location = useLocation()
  const { activeProfile, switchProfile } = useProfile()
  const [open, setOpen] = useState(false)
  const [showKeys, setShowKeys] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ movies: Movie[]; shows: Show[] }>({ movies: [], shows: [] })
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const inPlayer = location.pathname.startsWith('/play/') || /^\/live\/\d+/.test(location.pathname)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = isMac ? e.metaKey : e.ctrlKey
      // The player has its own keys.
      if (inPlayer) return
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setShowKeys(false)
        setOpen((v) => !v)
        return
      }
      if (mod && !e.shiftKey && !e.altKey) {
        const page = PAGES.find((p) => p.shortcut === e.key)
        if (page) {
          e.preventDefault()
          setOpen(false)
          navigate(page.path)
          return
        }
        if (e.key === '[') {
          e.preventDefault()
          navigate(-1)
          return
        }
        if (e.key === ']') {
          e.preventDefault()
          navigate(1)
          return
        }
      }
      if (typingInField(e) || mod || e.altKey) return
      if (e.key === '/') {
        e.preventDefault()
        setShowKeys(false)
        setOpen(true)
      } else if (e.key === '?') {
        e.preventDefault()
        setOpen(false)
        setShowKeys((v) => !v)
      } else if (e.key === 'Escape') {
        setShowKeys(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, inPlayer])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    setResults({ movies: [], shows: [] })
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults({ movies: [], shows: [] })
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      window.api.search
        .library(q)
        .then((r) => {
          if (!cancelled) setResults(r)
        })
        .catch(() => {})
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const items = useMemo(() => {
    const go = (path: string) => () => {
      setOpen(false)
      navigate(path)
    }
    const q = query.trim().toLowerCase()
    const titles: Item[] = [
      ...results.movies.slice(0, 6).map((m) => ({
        key: `m${m.id}`,
        label: m.title,
        hint: m.year ? `Movie · ${m.year}` : 'Movie',
        run: go(`/movie/${m.id}`)
      })),
      ...results.shows.slice(0, 6).map((s) => ({
        key: `s${s.id}`,
        label: s.title,
        hint: s.year ? `TV show · ${s.year}` : 'TV show',
        run: go(`/show/${s.id}`)
      }))
    ]
    const commands: Item[] = [
      ...PAGES.filter((p) => !p.adminOnly || activeProfile.isAdmin).map((p) => ({
        key: `p${p.path}`,
        label: `Go to ${p.label}`,
        hint: p.shortcut ? `${MOD}${p.shortcut}` : undefined,
        run: go(p.path)
      })),
      {
        key: 'switch',
        label: 'Switch profile',
        run: () => {
          setOpen(false)
          switchProfile()
        }
      },
      {
        key: 'keys',
        label: 'Keyboard shortcuts',
        hint: '?',
        run: () => {
          setOpen(false)
          setShowKeys(true)
        }
      }
    ].filter((c) => !q || c.label.toLowerCase().includes(q))
    const all = [...titles, ...commands]
    if (q) all.push({ key: 'all', label: `See all results for “${query.trim()}”`, run: go(`/search?q=${encodeURIComponent(query.trim())}`) })
    return all
  }, [query, results, activeProfile.isAdmin, navigate, switchProfile])

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, items.length - 1)))
  }, [items.length])

  if (showKeys) {
    return (
      <div className="palette-backdrop" onClick={() => setShowKeys(false)}>
        <div className="palette shortcuts" onClick={(e) => e.stopPropagation()}>
          <h2>Keyboard shortcuts</h2>
          <dl>
            {SHORTCUTS.map(([keys, what]) => (
              <div key={keys} className="shortcut-row">
                <dt>
                  <kbd>{keys}</kbd>
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    )
  }

  if (!open) return null

  return (
    <div className="palette-backdrop" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Search and go">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search titles or go to…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSelected((s) => Math.min(items.length - 1, s + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSelected((s) => Math.max(0, s - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              items[selected]?.run()
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
        />
        <ul className="palette-list" role="listbox">
          {items.map((item, i) => (
            <li
              key={item.key}
              role="option"
              aria-selected={i === selected}
              className={i === selected ? 'palette-item selected' : 'palette-item'}
              onMouseEnter={() => setSelected(i)}
              onClick={item.run}
            >
              <span>{item.label}</span>
              {item.hint && <span className="palette-hint">{item.hint}</span>}
            </li>
          ))}
          {items.length === 0 && <li className="palette-empty">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  )
}
