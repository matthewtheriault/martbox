import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Game, GameDetail, GameSaveInfo, GameSystem } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { useProfile } from '../lib/ProfileContext'
import { useBooksApi } from './Books'
import ArtTint from '../components/ArtTint'

// Retro games (Phase 7): the library with Continue Playing, a game's page,
// and the player (the server's /emulator/player.html, full screen).

export const SYSTEM_NAMES: Record<GameSystem, string> = {
  gb: 'Game Boy',
  gbc: 'Game Boy Color',
  gba: 'Game Boy Advance',
  nes: 'NES',
  snes: 'Super Nintendo',
  n64: 'Nintendo 64',
  nds: 'Nintendo DS',
  psx: 'PlayStation'
}
const SYSTEM_ORDER: GameSystem[] = ['gba', 'gbc', 'gb', 'nds', 'nes', 'snes', 'n64', 'psx']

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function when(sqlTime: string): string {
  const d = new Date(sqlTime.replace(' ', 'T') + 'Z')
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`
  return d.toLocaleDateString()
}

function profileQuery(id: number, pin: string | null): string {
  return `profileId=${id}${pin ? `&pin=${encodeURIComponent(pin)}` : ''}`
}

function useSaves(version = 0): GameSaveInfo[] | null {
  const { activeProfile, profilePin } = useProfile()
  return useBooksApi<GameSaveInfo[]>(`/api/games/saves?${profileQuery(activeProfile.id, profilePin)}`, version)
}

function Cover({ game, large }: { game: Game; large?: boolean }): JSX.Element {
  const port = usePort()
  return (
    <span className={large ? 'game-cover large' : 'game-cover'}>
      {game.hasCover ? (
        <img src={`http://127.0.0.1:${port}/api/games/${game.id}/cover`} alt="" loading="lazy" />
      ) : (
        <span className="game-cover-made">
          <span className="game-cover-title">{game.title}</span>
          <span className="game-cover-system">{SYSTEM_NAMES[game.system]}</span>
        </span>
      )}
    </span>
  )
}

function Card({ game, played }: { game: Game; played?: string }): JSX.Element {
  const navigate = useNavigate()
  return (
    <button className="music-album-card game-card" onClick={() => navigate(`/games/${game.id}`)} title={game.title}>
      <Cover game={game} />
      <span className="music-album-title">{game.title}</span>
      <span className="music-album-sub">{played ? `Played ${played}` : SYSTEM_NAMES[game.system]}</span>
    </button>
  )
}

export default function Games(): JSX.Element {
  const { gameId } = useParams<{ gameId?: string }>()
  if (gameId) return <GamePage id={Number(gameId)} />
  return <Library />
}

function Library(): JSX.Element {
  const games = useBooksApi<Game[]>('/api/games')
  const saves = useSaves()
  const [query, setQuery] = useState('')
  const [system, setSystem] = useState<GameSystem | 'all'>('all')

  const systems = useMemo(() => SYSTEM_ORDER.filter((s) => games?.some((g) => g.system === s)), [games])

  // Most recently saved first: what you were playing.
  const continuing = useMemo(() => {
    if (!games || !saves) return []
    const byId = new Map(games.map((g) => [g.id, g]))
    const seen = new Map<number, string>()
    for (const s of saves) if (!seen.has(s.gameId)) seen.set(s.gameId, s.updatedAt)
    return [...seen.entries()].map(([id, at]) => ({ game: byId.get(id), at })).filter((x): x is { game: Game; at: string } => !!x.game)
  }, [games, saves])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (games ?? []).filter((g) => (system === 'all' || g.system === system) && (!q || g.title.toLowerCase().includes(q)))
  }, [games, query, system])

  if (games && games.length === 0) {
    return (
      <div className="page">
        <h1 className="page-title">Games</h1>
        <p className="empty-state-inline">
          No games yet. Add a Games library folder in Settings → Libraries and scan it. Game Boy, Game Boy Color, Game Boy Advance, NES, Super
          Nintendo, Nintendo 64, Nintendo DS and PlayStation games are played; MartBox includes no games, so add backups of games you own.
        </p>
      </div>
    )
  }

  return (
    <div className="page music-page">
      <div className="music-head">
        <h1 className="page-title">Games</h1>
        <input className="input music-search" placeholder="Search games" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {!query && continuing.length > 0 && (
        <section>
          <h2 className="row-title">Continue playing</h2>
          <div className="music-grid game-grid">
            {continuing.slice(0, 6).map(({ game, at }) => (
              <Card key={game.id} game={game} played={when(at)} />
            ))}
          </div>
        </section>
      )}
      {systems.length > 1 && (
        <div className="reading-filters">
          <div className="music-tabs" role="tablist">
            {(['all', ...systems] as const).map((s) => (
              <button key={s} role="tab" aria-selected={system === s} className={system === s ? 'active' : ''} onClick={() => setSystem(s)}>
                {s === 'all' ? 'All' : SYSTEM_NAMES[s]}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="music-grid game-grid">
        {shown.map((g) => (
          <Card key={g.id} game={g} />
        ))}
      </div>
      {query && shown.length === 0 && <p className="empty-state-inline">Nothing matches “{query}”.</p>}
    </div>
  )
}

function GamePage({ id }: { id: number }): JSX.Element {
  const navigate = useNavigate()
  const port = usePort()
  const { activeProfile, profilePin } = useProfile()
  const game = useBooksApi<GameDetail>(`/api/games/${id}?${profileQuery(activeProfile.id, profilePin)}`)
  if (!game) return <div className="page" />
  const save = game.saves.find((s) => s.kind === 'save')
  const resume = game.saves.find((s) => s.kind === 'state' && s.slot === 0)
  const state = game.saves.find((s) => s.kind === 'state' && s.slot === 1)

  return (
    <div className="page music-page art-host">
      <ArtTint query={game.hasCover ? `kind=game&id=${game.id}` : null} />
      <button className="link-button" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <div className="music-album-hero">
        <Cover game={game} large />
        <div className="music-album-info">
          <p className="music-kicker">{SYSTEM_NAMES[game.system]}</p>
          <h1 className="music-album-name">{game.title}</h1>
          <p className="music-album-meta">{[game.region, size(game.size)].filter(Boolean).join(' · ')}</p>
          <div className="detail-actions">
            {resume ? (
              <>
                <button className="btn-primary" onClick={() => navigate(`/play-game/${game.id}?resume=1`)}>
                  Resume
                </button>
                <button className="btn-secondary" onClick={() => navigate(`/play-game/${game.id}`)}>
                  Start
                </button>
              </>
            ) : (
              <button className="btn-primary" onClick={() => navigate(`/play-game/${game.id}`)}>
                Play
              </button>
            )}
          </div>
          <ul className="game-saves">
            {resume && (
              <li>
                <span>Resume point</span>
                <span>{when(resume.updatedAt)}</span>
              </li>
            )}
            {save && (
              <li>
                <span>Game save</span>
                <span>{when(save.updatedAt)}</span>
              </li>
            )}
            {state && (
              <li>
                <span>Saved state</span>
                <span>{when(state.updatedAt)}</span>
              </li>
            )}
            {!resume && !save && !state && <li className="game-saves-empty">Not played yet. Saves are kept on the server and follow you to every device.</li>}
          </ul>
          {state?.hasScreenshot && (
            <img
              className="game-state-shot"
              src={`http://127.0.0.1:${port}/api/games/${game.id}/states/1/screenshot?${profileQuery(activeProfile.id, profilePin)}`}
              alt="Saved state"
            />
          )}
        </div>
      </div>
    </div>
  )
}

// --- Playing (full screen)

export function GamePlayer(): JSX.Element {
  const { gameId } = useParams<{ gameId: string }>()
  const navigate = useNavigate()
  const port = usePort()
  const { activeProfile, profilePin } = useProfile()
  const game = useBooksApi<GameDetail>(`/api/games/${gameId}`)
  const frame = useRef<HTMLIFrameElement>(null)
  const [quitting, setQuitting] = useState(false)
  const left = useRef(false)
  const leave = (): void => {
    if (left.current) return
    left.current = true
    navigate(-1)
  }
  const [search] = useSearchParams()
  const resume = search.get('resume') === '1'

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source === frame.current?.contentWindow && e.data?.martboxGame === 'exit') leave()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  })

  if (!game) return <div className="reader reader-loading">Loading…</div>

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3d8bff'
  const params = new URLSearchParams({
    game: String(game.id),
    core: game.core,
    direct: '1',
    name: game.title,
    color: accent,
    url: `/api/games/${game.id}/file/${encodeURIComponent(game.fileName)}`,
    profileId: String(activeProfile.id),
    ...(profilePin ? { pin: profilePin } : {}),
    ...(resume ? { resume: '1' } : {})
  })
  const quit = (): void => {
    setQuitting(true)
    frame.current?.contentWindow?.postMessage({ martboxGame: 'quit' }, '*')
    // If the page doesn't answer (it failed to start), leave anyway.
    window.setTimeout(leave, 5000)
  }

  return (
    <div className="game-player">
      <iframe
        ref={frame}
        title={game.title}
        src={`http://127.0.0.1:${port}/emulator/player.html?${params}`}
        allow="autoplay; fullscreen; gamepad"
      />
      <button className="game-player-quit" onClick={quit} disabled={quitting}>
        {quitting ? 'Saving…' : '← Quit'}
      </button>
    </div>
  )
}
