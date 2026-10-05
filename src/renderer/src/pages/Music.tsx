import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { MusicAlbum, MusicAlbumDetail, MusicArtist, MusicSearchResults, MusicTrack } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { musicPlayer } from '../lib/musicPlayer'
import { useMusic } from '../lib/useMusic'
import { formatTime } from '../lib/media'

// Music (Phase 4): albums, artists and songs from the server's music
// libraries; playing hands a queue to musicPlayer (lib/musicPlayer.ts).

function useMusicApi<T>(path: string | null): T | null {
  const port = usePort()
  const [data, setData] = useState<T | null>(null)
  useEffect(() => {
    if (!path) return
    let live = true
    setData(null)
    fetch(`http://127.0.0.1:${port}${path}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setData(d))
      .catch(() => live && setData(null))
    return () => {
      live = false
    }
  }, [port, path])
  return data
}

export function quality(t: { lossless: boolean; bitDepth: number | null; sampleRate: number | null; codec?: string | null }): string {
  if (!t.lossless) return t.codec ? t.codec.toUpperCase() : ''
  const parts = ['Lossless']
  if (t.bitDepth) parts.push(`${t.bitDepth}-bit`)
  if (t.sampleRate) parts.push(`${(t.sampleRate / 1000).toFixed(t.sampleRate % 1000 ? 1 : 0)} kHz`)
  return parts.join(' · ')
}

function AlbumCard({ album }: { album: MusicAlbum }): JSX.Element {
  const navigate = useNavigate()
  return (
    <button className="music-album-card" onClick={() => navigate(`/music/album/${album.id}`)} title={album.title}>
      <span className="music-cover">
        {album.hasCover ? <img src={musicPlayer.coverUrl(album.id)} alt="" loading="lazy" /> : <span>♪</span>}
      </span>
      <span className="music-album-title">{album.title}</span>
      <span className="music-album-sub">
        {album.artist}
        {album.year ? ` · ${album.year}` : ''}
      </span>
    </button>
  )
}

function TrackRows({ tracks, showAlbum, onPlay }: { tracks: MusicTrack[]; showAlbum?: boolean; onPlay: (i: number) => void }): JSX.Element {
  const music = useMusic()
  const playingId = music.queue[music.index]?.id
  const multiDisc = new Set(tracks.map((t) => t.discNumber)).size > 1
  return (
    <ol className="music-tracks">
      {tracks.map((t, i) => {
        const discStart = multiDisc && (i === 0 || tracks[i - 1].discNumber !== t.discNumber)
        return (
          <li key={t.id}>
            {discStart && <div className="music-disc">Disc {t.discNumber}</div>}
            <button className={t.id === playingId ? 'music-track playing' : 'music-track'} onDoubleClick={() => onPlay(i)} onClick={() => onPlay(i)}>
              <span className="music-track-no">{t.id === playingId && music.playing ? '♪' : (showAlbum ? i + 1 : t.trackNumber ?? i + 1)}</span>
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
            <button
              className="music-track-more"
              title="Play next"
              onClick={() => musicPlayer.enqueue([t], true)}
            >
              +
            </button>
          </li>
        )
      })}
    </ol>
  )
}

export default function Music(): JSX.Element {
  const { albumId, artistId } = useParams<{ albumId?: string; artistId?: string }>()
  if (albumId) return <AlbumPage id={Number(albumId)} />
  if (artistId) return <ArtistPage id={Number(artistId)} />
  return <MusicHome />
}

function MusicHome(): JSX.Element {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'albums' | 'artists' | 'songs'>('albums')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200)
    return () => clearTimeout(t)
  }, [query])
  const albums = useMusicApi<MusicAlbum[]>('/api/music/albums')
  const artists = useMusicApi<MusicArtist[]>(tab === 'artists' ? '/api/music/artists' : null)
  const songs = useMusicApi<MusicTrack[]>(tab === 'songs' ? '/api/music/tracks?limit=5000' : null)
  const search = useMusicApi<MusicSearchResults>(debounced ? `/api/music/search?q=${encodeURIComponent(debounced)}` : null)
  const recent = useMemo(
    () => [...(albums ?? [])].sort((a, b) => b.addedAt.localeCompare(a.addedAt)).slice(0, 12),
    [albums]
  )

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
            {(['albums', 'artists', 'songs'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {tab === 'albums' && (
            <>
              {recent.length > 0 && (albums?.length ?? 0) > 12 && (
                <section>
                  <h2 className="row-title">Recently added</h2>
                  <div className="music-grid">
                    {recent.map((a) => (
                      <AlbumCard key={a.id} album={a} />
                    ))}
                  </div>
                  <h2 className="row-title">All albums</h2>
                </section>
              )}
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
        <span className="music-cover large">
          {album.hasCover ? <img src={musicPlayer.coverUrl(album.id)} alt="" /> : <span>♪</span>}
        </span>
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
            <button className="btn-secondary" onClick={() => musicPlayer.enqueue(album.tracks, false)}>
              Add to Queue
            </button>
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
