import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Book, BookDetail, BookProgress } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { useProfile } from '../lib/ProfileContext'
import ArtTint from '../components/ArtTint'

// Books and comics (Phase 6): the library with Continue Reading, and a
// book's page. Reading happens full-screen in pages/Reader.tsx.

export function useBooksApi<T>(path: string | null, version = 0): T | null {
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

export function useBookProgress(version = 0): Map<number, BookProgress> | null {
  const { activeProfile, profilePin } = useProfile()
  const list = useBooksApi<BookProgress[]>(
    `/api/books/progress?profileId=${activeProfile.id}${profilePin ? `&pin=${encodeURIComponent(profilePin)}` : ''}`,
    version
  )
  return useMemo(() => (list ? new Map(list.map((p) => [p.bookId, p])) : null), [list])
}

export function bookLabel(book: Book): string {
  if (book.format === 'comic' && book.series && book.seriesIndex && book.title === `${book.series} ${book.seriesIndex}`) {
    return `${book.series} #${book.seriesIndex}`
  }
  return book.title
}

const FORMAT_NAME = { epub: 'EPUB', pdf: 'PDF', comic: 'Comic' }

function Cover({ book, large }: { book: Book; large?: boolean }): JSX.Element {
  const port = usePort()
  return (
    <span className={large ? 'reading-cover large' : 'reading-cover'}>
      {book.hasCover ? (
        <img src={`http://127.0.0.1:${port}/api/books/${book.id}/cover`} alt="" loading="lazy" />
      ) : (
        <span className="reading-cover-made">
          <span className="reading-cover-title">{book.title}</span>
          {book.author && <span className="reading-cover-author">{book.author}</span>}
        </span>
      )}
    </span>
  )
}

function Card({ book, progress }: { book: Book; progress?: BookProgress }): JSX.Element {
  const navigate = useNavigate()
  const fraction = progress && !progress.finished ? progress.fraction : 0
  return (
    <button className="music-album-card reading-card" onClick={() => navigate(`/books/${book.id}`)} title={book.title}>
      <span className="book-cover-wrap">
        <Cover book={book} />
        {fraction > 0.005 && (
          <span className="book-card-progress">
            <span style={{ width: `${fraction * 100}%` }} />
          </span>
        )}
        {progress?.finished && <span className="book-card-done">✓</span>}
      </span>
      <span className="music-album-title">{bookLabel(book)}</span>
      <span className="music-album-sub">{book.author ?? book.series ?? FORMAT_NAME[book.format]}</span>
    </button>
  )
}

export default function Books(): JSX.Element {
  const { bookId } = useParams<{ bookId?: string }>()
  if (bookId) return <BookPage id={Number(bookId)} />
  return <Library />
}

type Shelf = 'all' | 'books' | 'comics'

function Library(): JSX.Element {
  const books = useBooksApi<Book[]>('/api/books')
  const progress = useBookProgress()
  const [query, setQuery] = useState('')
  const [shelf, setShelf] = useState<Shelf>('all')
  const [sort, setSort] = useState<'author' | 'title' | 'added'>('author')

  const continuing = useMemo(() => {
    if (!books || !progress) return []
    const byId = new Map(books.map((b) => [b.id, b]))
    return [...progress.values()]
      .filter((p) => !p.finished && p.fraction > 0.001)
      .map((p) => byId.get(p.bookId))
      .filter((b): b is Book => b !== undefined)
  }, [books, progress])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (books ?? []).filter(
      (b) =>
        (shelf === 'all' || (shelf === 'comics') === (b.format === 'comic')) &&
        (!q || [b.title, b.author ?? '', b.series ?? ''].some((s) => s.toLowerCase().includes(q)))
    )
    if (sort === 'title') return [...list].sort((a, b) => bookLabel(a).localeCompare(bookLabel(b), undefined, { numeric: true }))
    if (sort === 'added') return [...list].sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    return list
  }, [books, query, shelf, sort])

  if (books && books.length === 0) {
    return (
      <div className="page">
        <h1 className="page-title">Books</h1>
        <p className="empty-state-inline">
          No books or comics yet. Add a Books &amp; Comics library folder in Settings → Libraries and scan it. EPUB, PDF, CBZ, CBR
          and CB7 files are read.
        </p>
      </div>
    )
  }

  return (
    <div className="page music-page">
      <div className="music-head">
        <h1 className="page-title">Books</h1>
        <input className="input music-search" placeholder="Search titles, authors, series" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {!query && continuing.length > 0 && (
        <section>
          <h2 className="row-title">Continue reading</h2>
          <div className="music-grid reading-grid">
            {continuing.slice(0, 6).map((b) => (
              <Card key={b.id} book={b} progress={progress?.get(b.id)} />
            ))}
          </div>
        </section>
      )}
      <div className="reading-filters">
        <div className="music-tabs" role="tablist">
          {(['all', 'books', 'comics'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={shelf === s} className={shelf === s ? 'active' : ''} onClick={() => setShelf(s)}>
              {s === 'all' ? 'All' : s === 'books' ? 'Books' : 'Comics'}
            </button>
          ))}
        </div>
        <select className="input reading-sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
          <option value="author">By author and series</option>
          <option value="title">By title</option>
          <option value="added">Recently added</option>
        </select>
      </div>
      <div className="music-grid reading-grid">
        {shown.map((b) => (
          <Card key={b.id} book={b} progress={progress?.get(b.id)} />
        ))}
      </div>
      {query && shown.length === 0 && <p className="empty-state-inline">Nothing matches “{query}”.</p>}
    </div>
  )
}

function BookPage({ id }: { id: number }): JSX.Element {
  const navigate = useNavigate()
  const port = usePort()
  const { activeProfile, profilePin } = useProfile()
  const [version, setVersion] = useState(0)
  const book = useBooksApi<BookDetail>(`/api/books/${id}`)
  const progress = useBookProgress(version)
  if (!book) return <div className="page" />
  const saved = progress?.get(book.id)
  const started = !!saved && !saved.finished && saved.fraction > 0.001

  const mark = async (finished: boolean): Promise<void> => {
    await fetch(`http://127.0.0.1:${port}/api/books/${book.id}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: activeProfile.id, pin: profilePin, locator: '', fraction: finished ? 1 : 0, finished })
    })
    setVersion((v) => v + 1)
  }

  return (
    <div className="page music-page art-host">
      <ArtTint query={book.hasCover ? `kind=book&id=${book.id}` : null} />
      <button className="link-button" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <div className="music-album-hero">
        <Cover book={book} large />
        <div className="music-album-info">
          <p className="music-kicker">{book.series ? `${book.series}${book.seriesIndex ? ` · #${book.seriesIndex}` : ''}` : FORMAT_NAME[book.format]}</p>
          <h1 className="music-album-name">{book.title}</h1>
          {book.author && <p className="book-byline">{book.author}</p>}
          <p className="music-album-meta">
            {[book.year, FORMAT_NAME[book.format], book.pageCount ? `${book.pageCount} pages` : null].filter(Boolean).join(' · ')}
          </p>
          {started && (
            <div className="book-progress">
              <span style={{ width: `${saved.fraction * 100}%` }} />
            </div>
          )}
          <div className="detail-actions">
            <button className="btn-primary" onClick={() => navigate(`/read/${book.id}`)}>
              {started ? `Continue (${Math.round(saved.fraction * 100)}%)` : 'Read'}
            </button>
            {started && (
              <button className="btn-secondary" onClick={() => navigate(`/read/${book.id}?from=start`)}>
                Start Over
              </button>
            )}
            <button className="btn-secondary" onClick={() => void mark(!saved?.finished)}>
              {saved?.finished ? 'Mark as Unread' : 'Mark as Finished'}
            </button>
          </div>
        </div>
      </div>
      {book.description && <p className="book-description">{book.description}</p>}
    </div>
  )
}
