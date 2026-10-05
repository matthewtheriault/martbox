import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type {
  MusicAlbum,
  MusicAlbumDetail,
  MusicArtist,
  MusicGenre,
  MusicListening,
  MusicPlaylist,
  MusicPlaylistDetail,
  MusicSearchResults,
  MusicTrack
} from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { useProfile } from '../lib/ProfileContext'
import { musicPlayer } from '../lib/musicPlayer'
import { useMusic } from '../lib/useMusic'
import { formatTime } from '../lib/media'

// Music (Phase 4): albums, artists, songs, genres and the person's own
// playlists from the server's music libraries; playing hands a queue to
// musicPlayer (lib/musicPlayer.ts).

// Reloads when `version` changes (after an edit).
function useMusicApi<T>(path: string | null, version = 0): T | null {
  const port = usePort()
  const [data, setData] = useState<T | null>(null)
  useEffect(() => {
    if (!path) return
    let live = true
    fetch(`http://127.0.0.1:${port}${path}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setData(d))
      .catch(() => live && setData(null))
    return () => {
      live = false
    }
  }, [port, path, version])
  return data
}

// The query/body fields that say whose playlists and history these are.
function useMusicProfile(): { query: string; body: { profileId: number; pin: string | null } } {
  const { activeProfile, profilePin } = useProfile()
  return useMemo(
    () => ({
      query: `profileId=${activeProfile.id}${profilePin ? `&pin=${encodeURIComponent(profilePin)}` : ''}`,
      body: { profileId: activeProfile.id, pin: profilePin }
    }),
    [activeProfile.id, profilePin]
  )
}

function useMusicPost(): <T = unknown>(path: string, body: Record<string, unknown>) => Promise<T | null> {
  const port = usePort()
  const { body: who } = useMusicProfile()
  return useCallback(
    async <T,>(path: string, body: Record<string, unknown>): Promise<T | null> => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...who, ...body })
        })
        return r.ok ? ((await r.json()) as T) : null
      } catch {
        return null
      }
    },
    [port, who]
  )
}

export function quality(t: { lossless: boolean; bitDepth: number | null; sampleRate: number | null; codec?: string | null }): string {
  if (!t.lossless) return t.codec ? t.codec.toUpperCase() : ''
  const parts = ['Lossless']
  if (t.bitDepth) parts.push(`${t.bitDepth}-bit`)
  if (t.sampleRate) parts.push(`${(t.sampleRate / 1000).toFixed(t.sampleRate % 1000 ? 1 : 0)} kHz`)
  return parts.join(' · ')
}

function Cover({ albumId, hasCover, className = 'music-cover' }: { albumId: number | null; hasCover: boolean; className?: string }): JSX.Element {
  return (
    <span className={className}>
      {hasCover && albumId !== null ? <img src={musicPlayer.coverUrl(albumId)} alt="" loading="lazy" /> : <span>♪</span>}
    </span>
  )
}

// Up to four covers in a square, for a playlist.
function Collage({ albumIds, large }: { albumIds: number[]; large?: boolean }): JSX.Element {
  if (albumIds.length < 4) return <Cover albumId={albumIds[0] ?? null} hasCover={albumIds.length > 0} className={large ? 'music-cover large' : 'music-cover'} />
  return (
    <span className={large ? 'music-cover large music-collage' : 'music-cover music-collage'}>
      {albumIds.map((id) => (
        <img key={id} src={musicPlayer.coverUrl(id)} alt="" loading="lazy" />
      ))}
    </span>
  )
}

function AlbumCard({ album }: { album: MusicAlbum }): JSX.Element {
  const navigate = useNavigate()
  return (
    <button className="music-album-card" onClick={() => navigate(`/music/album/${album.id}`)} title={album.title}>
      <Cover albumId={album.id} hasCover={album.hasCover} />
      <span className="music-album-title">{album.title}</span>
      <span className="music-album-sub">
        {album.artist}
        {album.year ? ` · ${album.year}` : ''}
      </span>
    </button>
  )
}

function PlaylistCard({ playlist }: { playlist: MusicPlaylist }): JSX.Element {
  const navigate = useNavigate()
  return (
    <button className="music-album-card" onClick={() => navigate(`/music/playlist/${playlist.id}`)} title={playlist.name}>
      <Collage albumIds={playlist.coverAlbumIds} />
      <span className="music-album-title">{playlist.name}</span>
      <span className="music-album-sub">{playlist.trackCount === 1 ? '1 song' : `${playlist.trackCount} songs`}</span>
    </button>
  )
}

interface MenuAction {
  label: string
  run: () => void | Promise<void>
}

// A song's (or several songs') "…" menu: queue actions, any extra actions,
// and adding to one of this person's playlists or a new one.
function SongMenu({
  tracks,
  extra = [],
  label = '…',
  className = 'music-track-more'
}: {
  tracks: MusicTrack[]
  extra?: MenuAction[]
  label?: string
  className?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [playlists, setPlaylists] = useState<MusicPlaylist[] | null>(null)
  const [newName, setNewName] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const port = usePort()
  const { query } = useMusicProfile()
  const post = useMusicPost()
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return
    fetch(`http://127.0.0.1:${port}/api/music/playlists?${query}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setPlaylists)
      .catch(() => setPlaylists([]))
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open, port, query])

  const finish = (message: string): void => {
    setDone(message)
    setTimeout(() => {
      setDone(null)
      setOpen(false)
    }, 900)
  }
  const ids = tracks.map((t) => t.id)
  const addTo = async (p: MusicPlaylist): Promise<void> => {
    if (await post(`/api/music/playlists/${p.id}/add`, { trackIds: ids })) finish(`Added to ${p.name}`)
  }
  const createWith = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    const made = await post<MusicPlaylistDetail>('/api/music/playlists', { name, trackIds: ids })
    if (!made) return
    setNewName('')
    setOpen(false)
    navigate(`/music/playlist/${made.id}`)
  }

  return (
    <div className="add-collection music-song-menu" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className={className} title="More" onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && (
        <div className="add-collection-menu">
          {done ? (
            <span className="music-menu-done">✓ {done}</span>
          ) : (
            <>
              <button onClick={() => (musicPlayer.enqueue(tracks, true), finish('Playing next'))}>Play Next</button>
              <button onClick={() => (musicPlayer.enqueue(tracks, false), finish('Added to the queue'))}>Add to Queue</button>
              {extra.map((a) => (
                <button key={a.label} onClick={() => void Promise.resolve(a.run()).then(() => setOpen(false))}>
                  {a.label}
                </button>
              ))}
              <span className="music-menu-heading">Add to Playlist</span>
              {playlists?.map((p) => (
                <button key={p.id} onClick={() => void addTo(p)}>
                  <span>{p.name}</span>
                </button>
              ))}
              <div className="add-collection-new">
                <input
                  className="input"
                  placeholder="New playlist"
                  maxLength={100}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void createWith()}
                />
                <button className="btn-primary" disabled={!newName.trim()} onClick={() => void createWith()}>
                  Add
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function TrackRows({
  tracks,
  showAlbum,
  onPlay,
  extraActions
}: {
  tracks: MusicTrack[]
  showAlbum?: boolean
  onPlay: (i: number) => void
  extraActions?: (i: number) => MenuAction[]
}): JSX.Element {
  const music = useMusic()
  const playingId = music.queue[music.index]?.id
  const multiDisc = !showAlbum && new Set(tracks.map((t) => t.discNumber)).size > 1
  return (
    <ol className="music-tracks">
      {tracks.map((t, i) => {
        const discStart = multiDisc && (i === 0 || tracks[i - 1].discNumber !== t.discNumber)
        return (
          <li key={`${t.id}-${i}`}>
            {discStart && <div className="music-disc">Disc {t.discNumber}</div>}
            <button className={t.id === playingId ? 'music-track playing' : 'music-track'} onClick={() => onPlay(i)}>
              <span className="music-track-no">{t.id === playingId && music.playing ? '♪' : showAlbum ? i + 1 : (t.trackNumber ?? i + 1)}</span>
              <span className="music-track-main">
                <span className="music-track-title">{t.title}</span>
                {(showAlbum || t.artist !== t.albumArtist) && (
                  <span className="music-track-sub">
                    {t.artist}
                    {showAlbum ? ` · ${t.album}` : ''}
                  </span>
                )}
              </span>
              <span className="music-track-time">{formatTime(t.durationSeconds)}</span>
            </button>
            <SongMenu tracks={[t]} extra={extraActions?.(i)} />
          </li>
        )
      })}
    </ol>
  )
}

export default function Music(): JSX.Element {
  const { albumId, artistId, genre, playlistId, kind } = useParams<{
    albumId?: string
    artistId?: string
    genre?: string
    playlistId?: string
    kind?: string
  }>()
  if (albumId) return <AlbumPage id={Number(albumId)} />
  if (artistId) return <ArtistPage id={Number(artistId)} />
  if (genre) return <GenrePage name={genre} />
  if (playlistId) return <PlaylistPage id={Number(playlistId)} />
  if (kind === 'recent' || kind === 'top') return <ListeningPage kind={kind} />
  return <MusicHome />
}

type Tab = 'albums' | 'artists' | 'songs' | 'genres' | 'playlists'
const TABS: Tab[] = ['albums', 'artists', 'songs', 'genres', 'playlists']

function MusicHome(): JSX.Element {
  const navigate = useNavigate()
  const { query: who } = useMusicProfile()
  const post = useMusicPost()
  const [tab, setTab] = useState<Tab>('albums')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [newName, setNewName] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200)
    return () => clearTimeout(t)
  }, [query])
  const albums = useMusicApi<MusicAlbum[]>('/api/music/albums')
  const listening = useMusicApi<MusicListening>(`/api/music/listening?${who}`)
  const artists = useMusicApi<MusicArtist[]>(tab === 'artists' ? '/api/music/artists' : null)
  const songs = useMusicApi<MusicTrack[]>(tab === 'songs' ? '/api/music/tracks?limit=5000' : null)
  const genres = useMusicApi<MusicGenre[]>(tab === 'genres' ? '/api/music/genres' : null)
  const playlists = useMusicApi<MusicPlaylist[]>(tab === 'playlists' ? `/api/music/playlists?${who}` : null)
  const search = useMusicApi<MusicSearchResults>(debounced ? `/api/music/search?q=${encodeURIComponent(debounced)}` : null)
  const recent = useMemo(
    () => [...(albums ?? [])].sort((a, b) => b.addedAt.localeCompare(a.addedAt)).slice(0, 12),
    [albums]
  )

  const createPlaylist = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    const made = await post<MusicPlaylistDetail>('/api/music/playlists', { name })
    if (made) navigate(`/music/playlist/${made.id}`)
  }

  if (albums && albums.length === 0) {
    return (
      <div className="page">
        <h1 className="page-title">Music</h1>
        <p className="empty-state-inline">
          No music yet. Add a Music library folder in Settings → Libraries and scan it.
        </p>
      </div>
    )
  }

  return (
    <div className="page music-page">
      <div className="music-head">
        <h1 className="page-title">Music</h1>
        <input
          className="input music-search"
          placeholder="Search artists, albums, songs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {debounced && search ? (
        <div className="music-results">
          {search.artists.length > 0 && (
            <section>
              <h2 className="row-title">Artists</h2>
              <div className="music-artist-list">
                {search.artists.map((a) => (
                  <button key={a.id} className="music-artist-chip" onClick={() => navigate(`/music/artist/${a.id}`)}>
                    {a.name}
                  </button>
                ))}
              </div>
            </section>
          )}
          {search.albums.length > 0 && (
            <section>
              <h2 className="row-title">Albums</h2>
              <div className="music-grid">
                {search.albums.map((a) => (
                  <AlbumCard key={a.id} album={a} />
                ))}
              </div>
            </section>
          )}
          {search.tracks.length > 0 && (
            <section>
              <h2 className="row-title">Songs</h2>
              <TrackRows tracks={search.tracks} showAlbum onPlay={(i) => void musicPlayer.playQueue(search.tracks, i)} />
            </section>
          )}
          {search.artists.length + search.albums.length + search.tracks.length === 0 && (
            <p className="empty-state-inline">Nothing matches “{debounced}”.</p>
          )}
        </div>
      ) : (
        <>
          <div className="music-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {tab === 'albums' && (
            <>
              {listening && listening.recentAlbums.length > 0 && (
                <section>
                  <h2 className="row-title">Recently played</h2>
                  <div className="music-grid">
                    {listening.recentAlbums.slice(0, 6).map((a) => (
                      <AlbumCard key={a.id} album={a} />
                    ))}
                  </div>
                </section>
              )}
              {recent.length > 0 && (albums?.length ?? 0) > 12 && (
                <section>
                  <h2 className="row-title">Recently added</h2>
                  <div className="music-grid">
                    {recent.map((a) => (
                      <AlbumCard key={a.id} album={a} />
                    ))}
                  </div>
                </section>
              )}
              {((listening?.recentAlbums.length ?? 0) > 0 || (albums?.length ?? 0) > 12) && <h2 className="row-title">All albums</h2>}
              <div className="music-grid">
                {albums?.map((a) => (
                  <AlbumCard key={a.id} album={a} />
                ))}
              </div>
            </>
          )}

          {tab === 'artists' && (
            <div className="music-grid">
              {artists?.map((a) => (
                <button key={a.id} className="music-album-card" onClick={() => navigate(`/music/artist/${a.id}`)}>
                  <span className="music-cover round">
                    {a.coverAlbumId ? <img src={musicPlayer.coverUrl(a.coverAlbumId)} alt="" loading="lazy" /> : <span>{a.name[0]}</span>}
                  </span>
                  <span className="music-album-title">{a.name}</span>
                  <span className="music-album-sub">{a.albumCount === 1 ? '1 album' : `${a.albumCount} albums`}</span>
                </button>
              ))}
            </div>
          )}

          {tab === 'songs' && songs && (
            <>
              <div className="detail-actions music-actions">
                <button className="btn-primary" onClick={() => void musicPlayer.playQueue(songs, 0, { shuffle: true })}>
                  Shuffle All
                </button>
              </div>
              <TrackRows tracks={songs} showAlbum onPlay={(i) => void musicPlayer.playQueue(songs, i)} />
            </>
          )}

          {tab === 'genres' &&
            (genres && genres.length === 0 ? (
              <p className="empty-state-inline">No genres yet. They come from the songs’ genre tags.</p>
            ) : (
              <div className="music-grid">
                {genres?.map((g) => (
                  <button key={g.name} className="music-album-card" onClick={() => navigate(`/music/genre/${encodeURIComponent(g.name)}`)}>
                    <Cover albumId={g.coverAlbumId} hasCover={g.coverAlbumId !== null} />
                    <span className="music-album-title">{g.name}</span>
                    <span className="music-album-sub">{g.albumCount === 1 ? '1 album' : `${g.albumCount} albums`}</span>
                  </button>
                ))}
              </div>
            ))}

          {tab === 'playlists' && (
            <>
              <div className="add-collection-new music-new-playlist">
                <input
                  className="input"
                  placeholder="New playlist name"
                  maxLength={100}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void createPlaylist()}
                />
                <button className="btn-primary" disabled={!newName.trim()} onClick={() => void createPlaylist()}>
                  New Playlist
                </button>
              </div>
              <div className="music-grid">
                {(listening?.recentTracks.length ?? 0) > 0 && (
                  <button className="music-album-card" onClick={() => navigate('/music/listening/recent')}>
                    <Collage albumIds={[...new Set(listening!.recentTracks.filter((t) => t.hasCover).map((t) => t.albumId))].slice(0, 4)} />
                    <span className="music-album-title">Recently Played</span>
                    <span className="music-album-sub">Made for you</span>
                  </button>
                )}
                {(listening?.topTracks.length ?? 0) > 0 && (
                  <button className="music-album-card" onClick={() => navigate('/music/listening/top')}>
                    <Collage albumIds={[...new Set(listening!.topTracks.filter((t) => t.hasCover).map((t) => t.albumId))].slice(0, 4)} />
                    <span className="music-album-title">Most Played</span>
                    <span className="music-album-sub">Last 90 days</span>
                  </button>
                )}
                {playlists?.map((p) => (
                  <PlaylistCard key={p.id} playlist={p} />
                ))}
              </div>
              {playlists && playlists.length === 0 && (
                <p className="empty-state-inline">No playlists yet. Name one above, or use a song’s … menu → Add to Playlist.</p>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

function AlbumPage({ id }: { id: number }): JSX.Element {
  const navigate = useNavigate()
  const album = useMusicApi<MusicAlbumDetail>(`/api/music/albums/${id}`)
  if (!album) return <div className="page" />
  return (
    <div className="page music-page">
      <button className="link-button" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <div className="music-album-hero">
        <Cover albumId={album.id} hasCover={album.hasCover} className="music-cover large" />
        <div className="music-album-info">
          <p className="music-kicker">Album</p>
          <h1 className="music-album-name">{album.title}</h1>
          <button className="link-button music-artist-link" onClick={() => navigate(`/music/artist/${album.artistId}`)}>
            {album.artist}
          </button>
          <p className="music-album-meta">
            {[album.year, `${album.trackCount} ${album.trackCount === 1 ? 'song' : 'songs'}`, formatTime(album.durationSeconds)]
              .filter(Boolean)
              .join(' · ')}
            {album.lossless && <span className="music-badge">{quality(album)}</span>}
          </p>
          <div className="detail-actions">
            <button className="btn-primary" onClick={() => void musicPlayer.playQueue(album.tracks, 0, { shuffle: false })}>
              Play
            </button>
            <button className="btn-secondary" onClick={() => void musicPlayer.playQueue(album.tracks, 0, { shuffle: true })}>
              Shuffle
            </button>
            <SongMenu tracks={album.tracks} label="More…" className="btn-secondary" />
          </div>
        </div>
      </div>
      <TrackRows tracks={album.tracks} onPlay={(i) => void musicPlayer.playQueue(album.tracks, i, { shuffle: false })} />
    </div>
  )
}

function ArtistPage({ id }: { id: number }): JSX.Element {
  const navigate = useNavigate()
  const albums = useMusicApi<MusicAlbum[]>(`/api/music/albums?artistId=${id}`)
  if (!albums) return <div className="page" />
  const name = albums[0]?.artist ?? 'Artist'
  return (
    <div className="page music-page">
      <button className="link-button" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <h1 className="page-title">{name}</h1>
      <div className="music-grid">
        {albums.map((a) => (
          <AlbumCard key={a.id} album={a} />
        ))}
      </div>
    </div>
  )
}

function GenrePage({ name }: { name: string }): JSX.Element {
  const navigate = useNavigate()
  const albums = useMusicApi<MusicAlbum[]>(`/api/music/albums?genre=${encodeURIComponent(name)}`)
  return (
    <div className="page music-page">
      <button className="link-button" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <p className="music-kicker">Genre</p>
      <h1 className="page-title">{name}</h1>
      <div className="music-grid">
        {albums?.map((a) => (
          <AlbumCard key={a.id} album={a} />
        ))}
      </div>
    </div>
  )
}

function PlaylistPage({ id }: { id: number }): JSX.Element {
  const navigate = useNavigate()
  const { query } = useMusicProfile()
  const post = useMusicPost()
  const [version, setVersion] = useState(0)
  const playlist = useMusicApi<MusicPlaylistDetail>(`/api/music/playlists/${id}?${query}`, version)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const reload = (): void => setVersion((v) => v + 1)

  if (!playlist) return <div className="page" />

  const rename = async (): Promise<void> => {
    const name = renaming?.trim()
    if (name && name !== playlist.name) await post(`/api/music/playlists/${id}/rename`, { name })
    setRenaming(null)
    reload()
  }
  const remove = async (): Promise<void> => {
    await post(`/api/music/playlists/${id}/delete`, {})
    navigate('/music')
  }
  const actions = (i: number): MenuAction[] => {
    const itemId = playlist.itemIds[i]
    const move = (to: number) => async (): Promise<void> => {
      await post(`/api/music/playlists/${id}/move`, { itemId, toIndex: to })
      reload()
    }
    return [
      ...(i > 0 ? [{ label: 'Move Up', run: move(i - 1) }] : []),
      ...(i < playlist.tracks.length - 1 ? [{ label: 'Move Down', run: move(i + 1) }] : []),
      {
        label: 'Remove from Playlist',
        run: async () => {
          await post(`/api/music/playlists/${id}/remove`, { itemId })
          reload()
        }
      }
    ]
  }

  return (
    <div className="page music-page">
      <button className="link-button" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <div className="music-album-hero">
        <Collage albumIds={playlist.coverAlbumIds} large />
        <div className="music-album-info">
          <p className="music-kicker">Playlist</p>
          {renaming !== null ? (
            <input
              className="input music-rename"
              autoFocus
              maxLength={100}
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={() => void rename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void rename()
                if (e.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <h1 className="music-album-name" title="Rename" onClick={() => setRenaming(playlist.name)}>
              {playlist.name}
            </h1>
          )}
          <p className="music-album-meta">
            {`${playlist.trackCount} ${playlist.trackCount === 1 ? 'song' : 'songs'}`}
            {playlist.trackCount > 0 && ` · ${formatTime(playlist.durationSeconds)}`}
          </p>
          <div className="detail-actions">
            <button
              className="btn-primary"
              disabled={playlist.tracks.length === 0}
              onClick={() => void musicPlayer.playQueue(playlist.tracks, 0, { shuffle: false })}
            >
              Play
            </button>
            <button
              className="btn-secondary"
              disabled={playlist.tracks.length === 0}
              onClick={() => void musicPlayer.playQueue(playlist.tracks, 0, { shuffle: true })}
            >
              Shuffle
            </button>
            <button className="btn-secondary" onClick={() => setRenaming(playlist.name)}>
              Rename
            </button>
            {confirmDelete ? (
              <button className="btn-danger" onClick={() => void remove()}>
                Delete “{playlist.name}”?
              </button>
            ) : (
              <button className="btn-secondary" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            )}
          </div>
        </div>
      </div>
      {playlist.tracks.length === 0 ? (
        <p className="empty-state-inline">Empty for now. Add songs from any song’s … menu.</p>
      ) : (
        <TrackRows
          tracks={playlist.tracks}
          showAlbum
          onPlay={(i) => void musicPlayer.playQueue(playlist.tracks, i, { shuffle: false })}
          extraActions={actions}
        />
      )}
    </div>
  )
}

// Recently Played and Most Played: lists made from this person's listening.
function ListeningPage({ kind }: { kind: 'recent' | 'top' }): JSX.Element {
  const navigate = useNavigate()
  const { query } = useMusicProfile()
  const listening = useMusicApi<MusicListening>(`/api/music/listening?${query}`)
  const tracks = listening ? (kind === 'recent' ? listening.recentTracks : listening.topTracks) : null
  return (
    <div className="page music-page">
      <button className="link-button" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <p className="music-kicker">Made for you</p>
      <h1 className="page-title">{kind === 'recent' ? 'Recently Played' : 'Most Played'}</h1>
      {tracks && (
        <>
          <div className="detail-actions music-actions">
            <button className="btn-primary" disabled={tracks.length === 0} onClick={() => void musicPlayer.playQueue(tracks, 0, { shuffle: false })}>
              Play
            </button>
            <button className="btn-secondary" disabled={tracks.length === 0} onClick={() => void musicPlayer.playQueue(tracks, 0, { shuffle: true })}>
              Shuffle
            </button>
          </div>
          <TrackRows tracks={tracks} showAlbum onPlay={(i) => void musicPlayer.playQueue(tracks, i)} />
        </>
      )}
    </div>
  )
}
