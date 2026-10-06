import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Audiobook, AudiobookDetail, AudiobookProgress } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { useProfile } from '../lib/ProfileContext'
import { bookPlayer, useBookPlayer } from '../lib/bookPlayer'
import { formatTime } from '../lib/media'
import ArtTint from '../components/ArtTint'

// Audiobooks (Phase 5): the library, Continue Listening, and a book's page
// with its chapters. Playback is bookPlayer (lib/bookPlayer.ts).

function useApi<T>(path: string | null, version = 0): T | null {
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

function useProgress(version = 0): Map<number, AudiobookProgress> | null {
  const { activeProfile, profilePin } = useProfile()
  const list = useApi<AudiobookProgress[]>(
    `/api/audiobooks/progress?profileId=${activeProfile.id}${profilePin ? `&pin=${encodeURIComponent(profilePin)}` : ''}`,
    version
  )
  return useMemo(() => (list ? new Map(list.map((p) => [p.bookId, p])) : null), [list])
}

function hoursMinutes(seconds: number): string {
  const m = Math.round(seconds / 60)
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`
}

function BookCover({ book, large }: { book: Audiobook; large?: boolean }): JSX.Element {
  return (
    <span className={large ? 'book-cover large' : 'book-cover'}>
      {book.hasCover ? <img src={bookPlayer.coverUrl(book.id)} alt="" loading="lazy" /> : <span className="book-cover-title">{book.title}</span>}
    </span>
  )
}

function BookCard({ book, progress }: { book: Audiobook; progress?: AudiobookProgress }): JSX.Element {
  const navigate = useNavigate()
  const fraction = progress && !progress.finished && book.durationSeconds > 0 ? progress.positionSeconds / book.durationSeconds : 0
  return (
    <button className="music-album-card book-card" onClick={() => navigate(`/audiobooks/${book.id}`)} title={book.title}>
      <span className="book-cover-wrap">
        <BookCover book={book} />
        {fraction > 0.005 && (
          <span className="book-card-progress">
            <span style={{ width: `${fraction * 100}%` }} />
          </span>
        )}
        {progress?.finished && <span className="book-card-done">✓</span>}
      </span>
      <span className="music-album-title">{book.title}</span>
      <span className="music-album-sub">{book.author}</span>
    </button>
  )
}

export default function Audiobooks(): JSX.Element {
  const { bookId } = useParams<{ bookId?: string }>()
  if (bookId) return <BookPage id={Number(bookId)} />
  return <Library />
}

function Library(): JSX.Element {
  const books = useApi<Audiobook[]>('/api/audiobooks')
  const progress = useProgress()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'author' | 'title' | 'added'>('author')

  const continuing = useMemo(() => {
    if (!books || !progress) return []
    const byId = new Map(books.map((b) => [b.id, b]))
    return [...progress.values()]
      .filter((p) => !p.finished && p.positionSeconds > 5)
      .map((p) => byId.get(p.bookId))
      .filter((b): b is Audiobook => b !== undefined)
  }, [books, progress])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (books ?? []).filter(
      (b) => !q || [b.title, b.author, b.narrator ?? '', b.series ?? ''].some((s) => s.toLowerCase().includes(q))
    )
    if (sort === 'title') return [...list].sort((a, b) => a.title.localeCompare(b.title))
    if (sort === 'added') return [...list].sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    return list
  }, [books, query, sort])

  if (books && books.length === 0) {
    return (
      <div className="page">
        <h1 className="page-title">Audiobooks</h1>
        <p className="empty-state-inline">
          No audiobooks yet. Add an Audiobooks library folder in Settings → Libraries and scan it. Each book is a folder of its
          files (or a single .m4b).
        </p>
      </div>
    )
  }

  return (
    <div className="page music-page">
      <div className="music-head">
        <h1 className="page-title">Audiobooks</h1>
        <input className="input music-search" placeholder="Search titles, authors, narrators" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {!query && continuing.length > 0 && (
        <section>
          <h2 className="row-title">Continue listening</h2>
          <div className="music-grid">
            {continuing.slice(0, 6).map((b) => (
              <BookCard key={b.id} book={b} progress={progress?.get(b.id)} />
            ))}
          </div>
        </section>
      )}
      <div className="music-tabs" role="tablist">
        {(['author', 'title', 'added'] as const).map((s) => (
          <button key={s} role="tab" aria-selected={sort === s} className={sort === s ? 'active' : ''} onClick={() => setSort(s)}>
            {s === 'author' ? 'By Author' : s === 'title' ? 'By Title' : 'Recently Added'}
          </button>
        ))}
      </div>
      <div className="music-grid">
        {shown.map((b) => (
          <BookCard key={b.id} book={b} progress={progress?.get(b.id)} />
        ))}
      </div>
      {query && shown.length === 0 && <p className="empty-state-inline">Nothing matches “{query}”.</p>}
    </div>
  )
}

function BookPage({ id }: { id: number }): JSX.Element {
  const navigate = useNavigate()
  const [version, setVersion] = useState(0)
  const book = useApi<AudiobookDetail>(`/api/audiobooks/${id}`)
  const progress = useProgress(version)
  const player = useBookPlayer()
  if (!book) return <div className="page" />

  const isOpen = player.book?.id === book.id
  const saved = progress?.get(book.id)
  const position = isOpen ? player.positionSeconds : saved && !saved.finished ? saved.positionSeconds : 0
  const started = position > 5
  const currentChapter = isOpen ? bookPlayer.chapterAt(player.positionSeconds)?.index ?? -1 : -1

  const play = (from: number): void => {
    if (isOpen && Math.abs(from - player.positionSeconds) < 1) void bookPlayer.toggle()
    else void bookPlayer.open(book, from)
  }
  const markFinished = async (finished: boolean): Promise<void> => {
    if (isOpen) bookPlayer.pause()
    await bookPlayer.markFinished(book, finished)
    setVersion((v) => v + 1)
  }

  return (
    <div className="page music-page art-host">
      <ArtTint query={book.hasCover ? `kind=audiobook&id=${book.id}` : null} />
      <button className="link-button" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <div className="music-album-hero">
        <BookCover book={book} large />
        <div className="music-album-info">
          <p className="music-kicker">{book.series ?? 'Audiobook'}</p>
          <h1 className="music-album-name">{book.title}</h1>
          <p className="book-byline">
            {book.author}
            {book.narrator && <span className="book-narrator"> · Narrated by {book.narrator}</span>}
          </p>
          <p className="music-album-meta">
            {[book.year, hoursMinutes(book.durationSeconds), `${book.chapters.length} ${book.chapters.length === 1 ? 'chapter' : 'chapters'}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {started && (
            <div className="book-progress">
              <span style={{ width: `${(position / book.durationSeconds) * 100}%` }} />
            </div>
          )}
          <div className="detail-actions">
            <button className="btn-primary" onClick={() => play(started ? position : 0)}>
              {isOpen && player.playing ? 'Pause' : started ? `Resume from ${formatTime(position)}` : 'Play'}
            </button>
            {started && (
              <button className="btn-secondary" onClick={() => void bookPlayer.open(book, 0)}>
                Start Over
              </button>
            )}
            {saved?.finished ? (
              <button className="btn-secondary" onClick={() => void markFinished(false)}>
                Mark as Unfinished
              </button>
            ) : (
              <button className="btn-secondary" onClick={() => void markFinished(true)}>
                Mark as Finished
              </button>
            )}
          </div>
        </div>
      </div>
      {book.description && <p className="book-description">{book.description}</p>}
      <h2 className="row-title">Chapters</h2>
      <ol className="music-tracks">
        {book.chapters.map((c, i) => (
          <li key={i}>
            <button className={i === currentChapter ? 'music-track playing' : 'music-track'} onClick={() => void bookPlayer.open(book, c.start)}>
              <span className="music-track-no">{i === currentChapter && player.playing ? '♪' : i + 1}</span>
              <span className="music-track-main">
                <span className="music-track-title">{c.title}</span>
              </span>
              <span className="music-track-time">{formatTime(c.end - c.start)}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
