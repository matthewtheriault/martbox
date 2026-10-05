import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import ePub, { type Book as EpubBook, type Rendition, type NavItem } from 'epubjs'
// The legacy build: the current one needs newer JavaScript than this
// Electron's Chromium has.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type { BookDetail, BookProgress } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { useProfile } from '../lib/ProfileContext'
import { bookLabel, useBooksApi, useBookProgress } from './Books'

// Full-screen reading: EPUB (epub.js, reflowing text), PDF (pdf.js) and
// comics (the server's page images). Each saves this person's place as
// they read, so another device opens at the same spot.

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

type Saver = (locator: string, fraction: number) => void

function useSaver(bookId: number): Saver {
  const port = usePort()
  const { activeProfile, profilePin } = useProfile()
  const timer = useRef<number | null>(null)
  const latest = useRef<{ locator: string; fraction: number } | null>(null)
  const flush = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    const p = latest.current
    if (!p) return
    latest.current = null
    void fetch(`http://127.0.0.1:${port}/api/books/${bookId}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: activeProfile.id, pin: profilePin, locator: p.locator, fraction: p.fraction, finished: p.fraction >= 0.995 }),
      keepalive: true
    }).catch(() => undefined)
  }, [port, bookId, activeProfile.id, profilePin])
  useEffect(() => () => flush(), [flush])
  return useCallback(
    (locator, fraction) => {
      latest.current = { locator, fraction }
      if (timer.current === null) timer.current = window.setTimeout(flush, 1500)
    },
    [flush]
  )
}

export default function Reader(): JSX.Element {
  const { bookId } = useParams<{ bookId: string }>()
  // A fresh reader per book, so one book never opens at another's place.
  return <BookReader key={bookId} id={Number(bookId)} />
}

function BookReader({ id }: { id: number }): JSX.Element {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const book = useBooksApi<BookDetail>(`/api/books/${id}`)
  const progress = useBookProgress()
  const save = useSaver(id)
  if (!book || !progress) return <div className="reader reader-loading">Opening…</div>
  const saved: BookProgress | undefined = params.get('from') === 'start' ? undefined : progress.get(id)
  const close = (): void => void navigate(-1)
  const props = { book, saved, save, close }
  if (book.format === 'epub') return <EpubReader {...props} />
  if (book.format === 'pdf') return <PdfReader {...props} />
  return <ComicReader {...props} />
}

interface ReaderProps {
  book: BookDetail
  saved: BookProgress | undefined
  save: Saver
  close: () => void
}

function TopBar({ book, close, children }: { book: BookDetail; close: () => void; children?: React.ReactNode }): JSX.Element {
  return (
    <div className="reader-top">
      <button className="reader-btn" onClick={close} title="Close (Esc)">
        ← Back
      </button>
      <span className="reader-title">{bookLabel(book)}</span>
      <div className="reader-tools">{children}</div>
    </div>
  )
}

function useKeys(handlers: Record<string, () => void>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return
      const fn = handlers[e.key]
      if (fn) {
        e.preventDefault()
        fn()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}

// --- EPUB

type Theme = 'light' | 'sepia' | 'dark'
const THEMES: Record<Theme, { body: Record<string, string> }> = {
  light: { body: { background: '#ffffff', color: '#1b1b1f' } },
  sepia: { body: { background: '#f4ecd8', color: '#433422' } },
  dark: { body: { background: '#121216', color: '#e6e6ea' } }
}

function remembered<T extends string | number>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    if (v === null) return fallback
    return (typeof fallback === 'number' ? Number(v) : v) as T
  } catch {
    return fallback
  }
}

function remember(key: string, value: string | number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    /* not remembered */
  }
}

function EpubReader({ book, saved, save, close }: ReaderProps): JSX.Element {
  const port = usePort()
  const host = useRef<HTMLDivElement>(null)
  const rendition = useRef<Rendition | null>(null)
  const epub = useRef<EpubBook | null>(null)
  const [theme, setTheme] = useState<Theme>(() => remembered<Theme>('martbox.readerTheme', 'light'))
  const [size, setSize] = useState<number>(() => remembered<number>('martbox.readerSize', 100))
  const [toc, setToc] = useState<NavItem[]>([])
  const [showToc, setShowToc] = useState(false)
  const [fraction, setFraction] = useState(saved?.fraction ?? 0)
  const [chapter, setChapter] = useState('')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!host.current) return
    let cancelled = false
    const b = ePub(`http://127.0.0.1:${port}/api/books/${book.id}/file`, { openAs: 'epub' })
    epub.current = b
    const r = b.renderTo(host.current, { width: '100%', height: '100%', flow: 'paginated', spread: 'auto', allowScriptedContent: false })
    rendition.current = r
    for (const [name, style] of Object.entries(THEMES)) r.themes.register(name, style)
    r.themes.select(theme)
    r.themes.fontSize(`${size}%`)
    r.on('relocated', (loc: { start: { cfi: string; href: string } }) => {
      const item = b.navigation?.get(loc.start.href)
      setChapter(item?.label?.trim() ?? '')
      // Until the book's locations are counted there's no percentage;
      // saving then would put a started book back to 0%.
      if (b.locations.length() === 0) return
      const pct = b.locations.percentageFromCfi(loc.start.cfi)
      setFraction(pct)
      save(loc.start.cfi, pct)
    })
    // Keys pressed while the page (an iframe) has focus.
    r.on('keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') void r.next()
      if (e.key === 'ArrowLeft') void r.prev()
      if (e.key === 'Escape') close()
    })
    b.ready
      .then(async () => {
        if (cancelled) return
        setToc(b.navigation.toc)
        await r.display(saved?.locator || undefined)
        setReady(true)
        // Positions as percentages (for the bar and other devices).
        await b.locations.generate(1200)
        if (!cancelled && r.location) {
          const pct = b.locations.percentageFromCfi(r.location.start.cfi)
          setFraction(pct)
          save(r.location.start.cfi, pct)
        }
      })
      .catch((e: unknown) => {
        console.warn('EPUB reader:', e)
        if (!cancelled) setError("Couldn't open this book.")
      })
    return () => {
      cancelled = true
      r.destroy()
      b.destroy()
    }
    // Opened once per book; theme and size apply live below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, book.id])

  useEffect(() => {
    rendition.current?.themes.select(theme)
    remember('martbox.readerTheme', theme)
  }, [theme])
  useEffect(() => {
    rendition.current?.themes.fontSize(`${size}%`)
    remember('martbox.readerSize', size)
  }, [size])

  useKeys({
    ArrowRight: () => void rendition.current?.next(),
    ArrowLeft: () => void rendition.current?.prev(),
    ' ': () => void rendition.current?.next(),
    Escape: close
  })

  return (
    <div className={`reader reader-epub reader-${theme}`}>
      <TopBar book={book} close={close}>
        <button className="reader-btn" onClick={() => setSize((s) => Math.max(70, s - 10))} title="Smaller text">
          A−
        </button>
        <button className="reader-btn" onClick={() => setSize((s) => Math.min(200, s + 10))} title="Larger text">
          A+
        </button>
        {(['light', 'sepia', 'dark'] as const).map((t) => (
          <button key={t} className={theme === t ? `reader-swatch swatch-${t} active` : `reader-swatch swatch-${t}`} onClick={() => setTheme(t)} title={t[0].toUpperCase() + t.slice(1)} />
        ))}
        <button className={showToc ? 'reader-btn active' : 'reader-btn'} onClick={() => setShowToc((v) => !v)}>
          Contents
        </button>
      </TopBar>
      {showToc && (
        <nav className="reader-toc">
          {toc.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                void rendition.current?.display(item.href)
                setShowToc(false)
              }}
            >
              {item.label.trim()}
            </button>
          ))}
        </nav>
      )}
      <div className="reader-stage">
        <button className="reader-turn left" onClick={() => void rendition.current?.prev()} aria-label="Previous page" />
        <div className="reader-epub-host" ref={host} />
        <button className="reader-turn right" onClick={() => void rendition.current?.next()} aria-label="Next page" />
        {!ready && !error && <div className="reader-overlay">Opening…</div>}
        {error && <div className="reader-overlay">{error}</div>}
      </div>
      <div className="reader-bottom">
        <span className="reader-chapter">{chapter}</span>
        <div className="reader-bar">
          <span style={{ width: `${fraction * 100}%` }} />
        </div>
        <span className="reader-pct">{Math.round(fraction * 100)}%</span>
      </div>
    </div>
  )
}

// --- PDF

function PdfReader({ book, saved, save, close }: ReaderProps): JSX.Element {
  const port = usePort()
  const canvas = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const doc = useRef<pdfjs.PDFDocumentProxy | null>(null)
  const [pages, setPages] = useState(0)
  const [page, setPage] = useState(() => Math.max(1, parseInt(saved?.locator ?? '', 10) || 1))
  const [fit, setFit] = useState<'page' | 'width'>(() => remembered<'page' | 'width'>('martbox.pdfFit', 'page'))
  const [error, setError] = useState<string | null>(null)
  const [, redraw] = useState(0)

  useEffect(() => {
    let cancelled = false
    const task = pdfjs.getDocument({ url: `http://127.0.0.1:${port}/api/books/${book.id}/file` })
    task.promise
      .then((d) => {
        if (cancelled) return
        doc.current = d
        setPages(d.numPages)
        setPage((p) => Math.min(p, d.numPages))
      })
      .catch((e: unknown) => {
        console.warn('PDF reader:', e)
        if (!cancelled) setError("Couldn't open this PDF.")
      })
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [port, book.id])

  useEffect(() => {
    const onResize = (): void => redraw((n) => n + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const d = doc.current
    if (!d || !canvas.current || !stage.current) return
    let cancelled = false
    let task: pdfjs.RenderTask | null = null
    void d.getPage(page).then((p) => {
      if (cancelled || !canvas.current || !stage.current) return
      const base = p.getViewport({ scale: 1 })
      const box = stage.current.getBoundingClientRect()
      const scale = fit === 'width' ? (box.width - 48) / base.width : Math.min((box.width - 48) / base.width, (box.height - 24) / base.height)
      const ratio = window.devicePixelRatio || 1
      const viewport = p.getViewport({ scale: scale * ratio })
      const c = canvas.current
      c.width = viewport.width
      c.height = viewport.height
      c.style.width = `${viewport.width / ratio}px`
      c.style.height = `${viewport.height / ratio}px`
      task = p.render({ canvas: c, canvasContext: c.getContext('2d')!, viewport })
      task.promise.catch(() => undefined)
    })
    if (pages > 0) save(String(page), pages > 1 ? (page - 1) / (pages - 1) : 1)
    remember('martbox.pdfFit', fit)
    return () => {
      cancelled = true
      task?.cancel()
    }
  })

  const go = (n: number): void => setPage((p) => Math.max(1, Math.min(pages || 1, p + n)))
  useKeys({ ArrowRight: () => go(1), ArrowLeft: () => go(-1), PageDown: () => go(1), PageUp: () => go(-1), ' ': () => go(1), Escape: close })

  return (
    <div className="reader reader-pdf">
      <TopBar book={book} close={close}>
        <button className={fit === 'page' ? 'reader-btn active' : 'reader-btn'} onClick={() => setFit('page')}>
          Whole page
        </button>
        <button className={fit === 'width' ? 'reader-btn active' : 'reader-btn'} onClick={() => setFit('width')}>
          Fit width
        </button>
      </TopBar>
      <div className={fit === 'width' ? 'reader-stage scroll' : 'reader-stage'} ref={stage}>
        <button className="reader-turn left" onClick={() => go(-1)} aria-label="Previous page" />
        <canvas ref={canvas} className="reader-pdf-page" />
        <button className="reader-turn right" onClick={() => go(1)} aria-label="Next page" />
        {error && <div className="reader-overlay">{error}</div>}
        {!error && pages === 0 && <div className="reader-overlay">Opening…</div>}
      </div>
      <PageBar page={page} pages={pages} setPage={setPage} />
    </div>
  )
}

function PageBar({ page, pages, setPage, rtl }: { page: number; pages: number; setPage: (p: number) => void; rtl?: boolean }): JSX.Element {
  return (
    <div className="reader-bottom">
      <input
        type="range"
        className={rtl ? 'reader-slider rtl' : 'reader-slider'}
        min={1}
        max={Math.max(1, pages)}
        value={page}
        onChange={(e) => setPage(parseInt(e.target.value, 10))}
        aria-label="Page"
      />
      <span className="reader-pct">
        {page} / {pages || '…'}
      </span>
    </div>
  )
}

// --- Comics

function ComicReader({ book, saved, save, close }: ReaderProps): JSX.Element {
  const port = usePort()
  const pages = book.pageCount ?? 0
  const [page, setPage] = useState(() => Math.max(1, Math.min(pages || 1, parseInt(saved?.locator ?? '', 10) || 1)))
  const [spread, setSpread] = useState(() => remembered<'one' | 'two'>('martbox.comicSpread', 'one'))
  const [rtl, setRtl] = useState(() => remembered<'ltr' | 'rtl'>(`martbox.comicDirection.${book.series ?? book.id}`, 'ltr') === 'rtl')
  const [zoom, setZoom] = useState(() => remembered<'fit' | 'width'>('martbox.comicZoom', 'fit'))
  const src = (p: number): string => `http://127.0.0.1:${port}/api/books/${book.id}/pages/${p - 1}`
  // Two-page spreads: the cover alone, then pairs (2–3, 4–5…).
  const step = spread === 'two' && page > 1 ? 2 : 1
  const shown = spread === 'two' && page > 1 && page + 1 <= pages ? [page, page + 1] : [page]

  useEffect(() => {
    if (pages > 0) save(String(page), pages > 1 ? (page - 1) / (pages - 1) : 1)
    // Fetch the next pages before they're turned to.
    for (let p = page + 1; p <= Math.min(pages, page + 3); p++) new Image().src = src(p)
  }, [page])

  useEffect(() => remember('martbox.comicSpread', spread), [spread])
  useEffect(() => remember('martbox.comicZoom', zoom), [zoom])
  useEffect(() => remember(`martbox.comicDirection.${book.series ?? book.id}`, rtl ? 'rtl' : 'ltr'), [rtl, book])

  const forward = (): void => setPage((p) => Math.min(pages, p === 1 && spread === 'two' ? 2 : p + step))
  const back = (): void => setPage((p) => Math.max(1, spread === 'two' && p > 2 ? p - 2 : p - 1))
  // In manga mode the left side moves forward.
  const left = rtl ? forward : back
  const right = rtl ? back : forward
  useKeys({ ArrowRight: right, ArrowLeft: left, ' ': forward, PageDown: forward, PageUp: back, Escape: close })

  return (
    <div className="reader reader-comic">
      <TopBar book={book} close={close}>
        <button className={spread === 'one' ? 'reader-btn active' : 'reader-btn'} onClick={() => setSpread('one')}>
          One page
        </button>
        <button className={spread === 'two' ? 'reader-btn active' : 'reader-btn'} onClick={() => setSpread('two')}>
          Two pages
        </button>
        <button className={zoom === 'width' ? 'reader-btn active' : 'reader-btn'} onClick={() => setZoom(zoom === 'fit' ? 'width' : 'fit')} title="Zoom">
          {zoom === 'fit' ? 'Fit width' : 'Whole page'}
        </button>
        <button className={rtl ? 'reader-btn active' : 'reader-btn'} onClick={() => setRtl((v) => !v)} title="Right-to-left (manga)">
          Manga ⇠
        </button>
      </TopBar>
      <div className={zoom === 'width' ? 'reader-stage scroll' : 'reader-stage'}>
        <button className="reader-turn left" onClick={left} aria-label={rtl ? 'Next page' : 'Previous page'} />
        <div className={`reader-comic-pages ${zoom} ${rtl ? 'rtl' : ''}`}>
          {shown.map((p) => (
            <img key={p} src={src(p)} alt={`Page ${p}`} />
          ))}
        </div>
        <button className="reader-turn right" onClick={right} aria-label={rtl ? 'Previous page' : 'Next page'} />
        {pages === 0 && <div className="reader-overlay">This comic has no pages.</div>}
      </div>
      <PageBar page={page} pages={pages} setPage={setPage} rtl={rtl} />
    </div>
  )
}
