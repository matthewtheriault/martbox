import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  Channel,
  ChannelBlock,
  ChannelConfig,
  ChannelGuide,
  ChannelSource,
  Movie,
  Show
} from '../../../shared/types'
import { useProfile } from '../lib/ProfileContext'
import { usePort } from '../lib/PortContext'
import { imageUrl } from '../lib/media'

// Live Channels: always-on channels made from the library (src/main/
// channels.ts), shown as a TV guide. Picking a channel tunes in to whatever
// is on right now (LivePlayer.tsx). The admin builds channels here too, on
// the server PC.

const GUIDE_HOURS = 3
const SLOT_MINUTES = 30
const PX_PER_MINUTE = 7

function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function sourceLabel(source: ChannelSource, shows: Show[], movies: Movie[]): string {
  if (source.kind === 'show') return shows.find((s) => s.id === source.showId)?.title ?? 'A show'
  const parts = [
    source.genre,
    source.decade ? `${source.decade}s` : null,
    source.collectionId
      ? movies.find((m) => m.collectionId === source.collectionId)?.collectionName
      : null
  ].filter(Boolean)
  return parts.length ? `${parts.join(' · ')} movies` : 'All movies'
}

// Picks what a lineup plays: shows, and movies by genre / decade /
// collection. Used for the main lineup, each time block, and filler.
function SourcePicker({
  sources,
  onChange,
  shows,
  movies
}: {
  sources: ChannelSource[]
  onChange: (sources: ChannelSource[]) => void
  shows: Show[]
  movies: Movie[]
}): JSX.Element {
  const [showQuery, setShowQuery] = useState('')
  const [genre, setGenre] = useState('')
  const [decade, setDecade] = useState('')
  const [collection, setCollection] = useState('')

  const genres = useMemo(
    () => [...new Set(movies.flatMap((m) => m.genres))].sort((a, b) => a.localeCompare(b)),
    [movies]
  )
  const decades = useMemo(
    () =>
      [...new Set(movies.map((m) => (m.year ? Math.floor(m.year / 10) * 10 : null)))]
        .filter((d): d is number => d !== null)
        .sort((a, b) => a - b),
    [movies]
  )
  const collections = useMemo(() => {
    const byId = new Map<number, string>()
    for (const m of movies) {
      if (m.collectionId && m.collectionName) byId.set(m.collectionId, m.collectionName)
    }
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [movies])

  const pickedShows = new Set(sources.flatMap((s) => (s.kind === 'show' ? [s.showId] : [])))
  const matchingShows = shows
    .filter((s) => s.title.toLowerCase().includes(showQuery.trim().toLowerCase()))
    .slice(0, 40)

  const toggleShow = (showId: number): void => {
    onChange(
      pickedShows.has(showId)
        ? sources.filter((s) => !(s.kind === 'show' && s.showId === showId))
        : [...sources, { kind: 'show', showId }]
    )
  }

  const addMovies = (): void => {
    onChange([
      ...sources,
      {
        kind: 'movies',
        genre: genre || null,
        decade: decade ? Number(decade) : null,
        collectionId: collection ? Number(collection) : null
      }
    ])
    setGenre('')
    setDecade('')
    setCollection('')
  }

  return (
    <>
      {sources.length === 0 ? (
        <p className="dash-dim">Nothing yet — add shows or movies below.</p>
      ) : (
        <div className="live-sources">
          {sources.map((source, i) => (
            <span key={i} className="live-source-chip">
              {sourceLabel(source, shows, movies)}
              <button
                onClick={() => onChange(sources.filter((_, j) => j !== i))}
                aria-label="Remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="live-editor-pickers">
        <div className="live-editor-shows">
          <input
            type="search"
            placeholder="Find a show…"
            value={showQuery}
            onChange={(e) => setShowQuery(e.target.value)}
          />
          <div className="live-show-list">
            {matchingShows.map((show) => (
              <label key={show.id} className="req-season">
                <input
                  type="checkbox"
                  checked={pickedShows.has(show.id)}
                  onChange={() => toggleShow(show.id)}
                />
                {show.title}
                {show.year && <span className="dash-dim"> ({show.year})</span>}
              </label>
            ))}
            {shows.length === 0 && <span className="dash-dim">No shows in the library.</span>}
          </div>
        </div>
        <div className="live-editor-movies">
          <span className="dash-dim">Movies</span>
          <select value={genre} onChange={(e) => setGenre(e.target.value)}>
            <option value="">Any genre</option>
            {genres.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
          <select value={decade} onChange={(e) => setDecade(e.target.value)}>
            <option value="">Any decade</option>
            {decades.map((d) => (
              <option key={d} value={d}>
                {d}s
              </option>
            ))}
          </select>
          <select value={collection} onChange={(e) => setCollection(e.target.value)}>
            <option value="">Any collection</option>
            {collections.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <button
            className="btn-secondary dash-small-btn"
            onClick={addMovies}
            disabled={movies.length === 0}
          >
            Add movies
          </button>
        </div>
      </div>
    </>
  )
}

function ChannelEditor({
  channel,
  nextNumber,
  shows,
  movies,
  port,
  onClose,
  onSaved
}: {
  channel: Channel | null
  nextNumber: number
  shows: Show[]
  movies: Movie[]
  port: number
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const { activeProfile } = useProfile()
  const [tab, setTab] = useState<'lineup' | 'blocks' | 'filler'>('lineup')
  const [name, setName] = useState(channel?.name ?? '')
  const [number, setNumber] = useState(String(channel?.number ?? nextNumber))
  const [sources, setSources] = useState<ChannelSource[]>(channel?.sources ?? [])
  const [order, setOrder] = useState<ChannelConfig['order']>(channel?.order ?? 'shuffle')
  const [maxQuality, setMaxQuality] = useState<ChannelConfig['maxQuality']>(
    channel?.maxQuality ?? '1080'
  )
  const [blocks, setBlocks] = useState<ChannelBlock[]>(channel?.blocks ?? [])
  const [filler, setFiller] = useState<ChannelSource[]>(channel?.filler ?? [])
  const [logoPath, setLogoPath] = useState<string | null>(channel?.logoPath ?? null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const updateBlock = (i: number, patch: Partial<ChannelBlock>): void => {
    setBlocks(blocks.map((b, j) => (j === i ? { ...b, ...patch } : b)))
  }

  const save = async (): Promise<void> => {
    if (!name.trim() || sources.length === 0) {
      setError('Give it a name and at least one show or set of movies.')
      return
    }
    if (blocks.some((b) => b.sources.length === 0)) {
      setError('Each time block needs something to play (or remove it).')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await window.api.channels.save(activeProfile.id, channel?.id ?? null, {
        name,
        number: Number(number) || nextNumber,
        sources,
        order,
        maxQuality,
        blocks,
        filler,
        logoPath
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="req-modal-backdrop" onClick={onClose}>
      <div className="req-modal live-editor" onClick={(e) => e.stopPropagation()}>
        <button className="req-modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h2>{channel ? 'Edit channel' : 'New channel'}</h2>
        <div className="live-editor-row">
          <button
            className="live-logo-pick"
            onClick={() =>
              window.api.channels
                .pickLogo(activeProfile.id)
                .then((path) => path && setLogoPath(path))
                .catch(() => {})
            }
            title="Choose a logo"
          >
            {logoPath ? <img src={imageUrl(logoPath, port)} alt="" /> : <span>Logo</span>}
          </button>
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Simpsons 24/7"
            />
          </label>
          <label className="live-editor-number">
            Number
            <input
              type="number"
              min="1"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
            />
          </label>
        </div>
        {logoPath && (
          <button className="dash-stop" onClick={() => setLogoPath(null)}>
            Remove logo
          </button>
        )}

        <div className="dash-tabs">
          {(
            [
              ['lineup', 'Lineup'],
              ['blocks', `Time blocks${blocks.length ? ` (${blocks.length})` : ''}`],
              ['filler', `Filler${filler.length ? ` (${filler.length})` : ''}`]
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? 'dash-tab active' : 'dash-tab'}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'lineup' && (
          <>
            <p className="settings-hint">What it plays the rest of the time.</p>
            <SourcePicker sources={sources} onChange={setSources} shows={shows} movies={movies} />
            <div className="live-editor-row">
              <label>
                Order
                <select
                  value={order}
                  onChange={(e) => setOrder(e.target.value as ChannelConfig['order'])}
                >
                  <option value="shuffle">Shuffle</option>
                  <option value="inOrder">In order</option>
                </select>
              </label>
              <label>
                Highest quality
                <select
                  value={maxQuality}
                  onChange={(e) => setMaxQuality(e.target.value as ChannelConfig['maxQuality'])}
                >
                  <option value="auto">Same as the viewer’s setting</option>
                  <option value="1080">1080p</option>
                  <option value="720">720p</option>
                  <option value="480">480p</option>
                </select>
              </label>
            </div>
            <p className="settings-hint">
              A capped channel never streams above that, even if it’s left on all day.
            </p>
          </>
        )}

        {tab === 'blocks' && (
          <>
            <p className="settings-hint">
              Something else at set times each day (the server PC’s time). At the start and end of
              a block it cuts over, like real TV.
            </p>
            {blocks.map((block, i) => (
              <div key={i} className="live-block">
                <div className="live-editor-row">
                  <label>
                    From
                    <input
                      type="time"
                      value={block.start}
                      onChange={(e) => updateBlock(i, { start: e.target.value })}
                    />
                  </label>
                  <label>
                    Until
                    <input
                      type="time"
                      value={block.end}
                      onChange={(e) => updateBlock(i, { end: e.target.value })}
                    />
                  </label>
                  <label>
                    Order
                    <select
                      value={block.order}
                      onChange={(e) =>
                        updateBlock(i, { order: e.target.value as ChannelBlock['order'] })
                      }
                    >
                      <option value="shuffle">Shuffle</option>
                      <option value="inOrder">In order</option>
                    </select>
                  </label>
                  <button
                    className="dash-stop"
                    onClick={() => setBlocks(blocks.filter((_, j) => j !== i))}
                  >
                    Remove block
                  </button>
                </div>
                <SourcePicker
                  sources={block.sources}
                  onChange={(next) => updateBlock(i, { sources: next })}
                  shows={shows}
                  movies={movies}
                />
              </div>
            ))}
            <button
              className="btn-secondary dash-small-btn live-add-block"
              onClick={() =>
                setBlocks([...blocks, { start: '07:00', end: '11:00', sources: [], order: 'shuffle' }])
              }
            >
              Add a time block
            </button>
          </>
        )}

        {tab === 'filler' && (
          <>
            <p className="settings-hint">
              Played between programs — short things you have as files, like bumpers, trailers or
              music videos. Leave empty for programs back to back.
            </p>
            <SourcePicker sources={filler} onChange={setFiller} shows={shows} movies={movies} />
          </>
        )}

        {error && <p className="req-error">{error}</p>}
        <div className="live-editor-actions">
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Building the schedule…' : 'Save channel'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Live(): JSX.Element {
  const { activeProfile, isHost } = useProfile()
  const navigate = useNavigate()
  const port = usePort()
  const [guide, setGuide] = useState<ChannelGuide | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [editing, setEditing] = useState<Channel | null | 'new'>(null)
  const [managing, setManaging] = useState(false)
  const [channels, setChannels] = useState<Channel[]>([])
  const [shows, setShows] = useState<Show[]>([])
  const [movies, setMovies] = useState<Movie[]>([])
  const canManage = activeProfile.isAdmin && isHost

  // The guide starts at the last half-hour mark.
  const from = Math.floor(now / (SLOT_MINUTES * 60_000)) * SLOT_MINUTES * 60_000
  const to = from + GUIDE_HOURS * 60 * 60_000

  const load = (): void => {
    window.api.channels
      .guide(from, to)
      .then((g) => {
        setGuide(g)
        setError(null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    if (canManage)
      window.api.channels
        .list(activeProfile.id)
        .then(setChannels)
        .catch(() => {})
  }

  useEffect(load, [from, canManage])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!canManage) return
    window.api.shows
      .list()
      .then(setShows)
      .catch(() => {})
    window.api.movies
      .list()
      .then(setMovies)
      .catch(() => {})
  }, [canManage])

  const width = (ms: number): number => (ms / 60_000) * PX_PER_MINUTE
  const ticks = Array.from(
    { length: (GUIDE_HOURS * 60) / SLOT_MINUTES },
    (_, i) => from + i * SLOT_MINUTES * 60_000
  )

  return (
    <div className="page">
      <div className="page-title-row">
        <h1 className="page-title">Live</h1>
        {canManage && (
          <button className="btn-secondary" onClick={() => setManaging(!managing)}>
            {managing ? 'Done' : 'Edit Channels'}
          </button>
        )}
      </div>
      <p className="dash-summary">
        Always-on channels from the MartBox library. Pick one to tune in.
      </p>

      {managing && (
        <section className="dash-section">
          <div className="dash-section-head">
            <h2>Channels</h2>
            <button className="btn-primary dash-small-btn" onClick={() => setEditing('new')}>
              New channel
            </button>
          </div>
          {channels.length === 0 ? (
            <p className="empty-state-inline">No channels yet.</p>
          ) : (
            <div className="dash-requests">
              {channels.map((c) => (
                <div key={c.id} className="dash-request">
                  <div className="live-number">{c.number}</div>
                  <div className="dash-request-body">
                    <div className="dash-stream-title">{c.name}</div>
                    <div className="dash-dim">
                      {c.sources.map((s) => sourceLabel(s, shows, movies)).join(', ')} ·{' '}
                      {c.itemCount} items · {c.order === 'shuffle' ? 'shuffled' : 'in order'}
                      {c.maxQuality !== 'auto' ? ` · up to ${c.maxQuality}p` : ''}
                      {c.blocks?.length
                        ? ` · ${c.blocks.length} time block${c.blocks.length === 1 ? '' : 's'}`
                        : ''}
                      {c.filler?.length ? ' · filler' : ''}
                    </div>
                  </div>
                  <div className="dash-request-actions">
                    <button className="btn-secondary dash-small-btn" onClick={() => setEditing(c)}>
                      Edit
                    </button>
                    <button
                      className="dash-stop"
                      onClick={() =>
                        window.api.channels
                          .remove(activeProfile.id, c.id)
                          .then(load)
                          .catch(() => {})
                      }
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {error && <p className="empty-state-inline">{error}</p>}
      {guide && guide.channels.length === 0 && (
        <p className="empty-state-inline">
          {canManage
            ? 'No channels yet — use Edit Channels to make one.'
            : 'No channels yet. The server owner can make some.'}
        </p>
      )}

      {guide && guide.channels.length > 0 && (
        <div className="live-guide">
          <div className="live-guide-inner" style={{ width: 200 + width(to - from) }}>
            <div className="live-guide-times">
              <div className="live-guide-corner" />
              {ticks.map((t) => (
                <div
                  key={t}
                  className="live-guide-tick"
                  style={{ width: width(SLOT_MINUTES * 60_000) }}
                >
                  {clock(t)}
                </div>
              ))}
            </div>
            {guide.channels.map(({ channel, programs }) => (
              <div key={channel.id} className="live-guide-row">
                <button
                  className="live-guide-channel"
                  onClick={() => navigate(`/live/${channel.id}`)}
                >
                  {channel.logoPath ? (
                    <img className="live-logo" src={imageUrl(channel.logoPath, port)} alt="" />
                  ) : (
                    <span className="live-number">{channel.number}</span>
                  )}
                  <span>{channel.name}</span>
                </button>
                <div className="live-guide-programs">
                  {programs.map((p) => {
                    const start = Math.max(p.start, from)
                    const end = Math.min(p.end, to)
                    const onNow = p.start <= now && now < p.end
                    return (
                      <button
                        key={`${p.mediaType}-${p.mediaId}-${p.start}`}
                        className={onNow ? 'live-program on-now' : 'live-program'}
                        style={{
                          left: width(start - from),
                          width: Math.max(width(end - start) - 4, 2)
                        }}
                        onClick={() => navigate(`/live/${channel.id}`)}
                        title={`${p.title} — ${p.subtitle}`}
                      >
                        {/* Too narrow to read (a few minutes): the tooltip has it. */}
                        {width(end - start) >= 48 && (
                          <>
                            <span className="live-program-title">{p.title}</span>
                            <span className="live-program-sub">
                              {clock(p.start)} · {p.subtitle}
                            </span>
                          </>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            <div className="live-now-line" style={{ left: 200 + width(now - from) }} />
          </div>
        </div>
      )}

      {editing && (
        <ChannelEditor
          port={port}
          channel={editing === 'new' ? null : editing}
          nextNumber={Math.max(0, ...channels.map((c) => c.number)) + 1}
          shows={shows}
          movies={movies}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </div>
  )
}
