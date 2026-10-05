import { app } from 'electron'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, extname, basename, dirname } from 'path'
import express from 'express'
import type { Express, Request, Response } from 'express'
import ffmpegStatic from 'ffmpeg-static'
import yauzl from 'yauzl'
import SevenZip from '7z-wasm'
import { db } from './db'
import { comicInfoMeta, comicNameMeta, comicPages, epubMeta, formatOf, opfPath, type BookFormat, type BookMeta } from './booksCore'
import { sortKey } from './musicCore'
import type { Book, BookDetail, BookProgress, Library, ScanProgress } from '../shared/types'

// Books and comics (Phase 6): EPUB and PDF books are sent as they are and
// read in the apps; comics (CBZ, CBR, CB7) are unpacked here once and sent
// a page at a time. Each person's place in each book is kept and synced.

const ffmpegPath = (ffmpegStatic as string).replace('app.asar', 'app.asar.unpacked')

db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL UNIQUE,
    format TEXT NOT NULL,
    title TEXT NOT NULL,
    sort_title TEXT NOT NULL,
    author TEXT,
    sort_author TEXT NOT NULL DEFAULT '',
    series TEXT,
    series_index TEXT,
    year INTEGER,
    description TEXT,
    pages TEXT,
    page_count INTEGER,
    cover_path TEXT,
    signature TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS book_progress (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    locator TEXT NOT NULL DEFAULT '',
    fraction REAL NOT NULL DEFAULT 0,
    finished INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (profile_id, book_id)
  );
`)

function userDir(name: string): string {
  const d = join(app.getPath('userData'), name)
  mkdirSync(d, { recursive: true })
  return d
}

// --- Archives (7-Zip, as WebAssembly: ZIP, RAR and 7z alike)

// One 7-Zip run with real folders mounted; a fresh instance each time (its
// main() runs once).
async function sevenZip(args: string[], mounts: [real: string, at: string][]): Promise<{ code: number; out: string }> {
  let out = ''
  const sz = await SevenZip({ print: (line: string) => (out += line + '\n'), printErr: () => undefined })
  for (const [real, at] of mounts) {
    sz.FS.mkdir(at)
    sz.FS.mount(sz.NODEFS, { root: real }, at)
  }
  const code = sz.callMain(['-bsp0', ...args]) as unknown as number
  return { code: code ?? 0, out }
}

async function archiveEntries(file: string): Promise<string[]> {
  const { out } = await sevenZip(['l', '-slt', '-ba', `/in/${basename(file)}`], [[dirname(file), '/in']])
  return [...out.matchAll(/Path = (.+)/g)].map((m) => m[1])
}

// Unpacks some (or all, with none named) of an archive's files into `dest`.
async function extract(file: string, dest: string, names: string[] = []): Promise<boolean> {
  mkdirSync(dest, { recursive: true })
  const { code } = await sevenZip(['x', '-y', '-o/out', `/in/${basename(file)}`, ...names], [[dirname(file), '/in'], [dest, '/out']])
  return code === 0
}

// --- EPUB (a ZIP): its package file and cover

function zipRead(file: string, wanted: (name: string) => boolean): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const found = new Map<string, Buffer>()
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err)
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!wanted(entry.fileName)) return zip.readEntry()
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return zip.readEntry()
          const chunks: Buffer[] = []
          stream.on('data', (c: Buffer) => chunks.push(c))
          stream.on('end', () => {
            found.set(entry.fileName, Buffer.concat(chunks))
            zip.readEntry()
          })
        })
      })
      zip.on('end', () => resolve(found))
      zip.on('error', reject)
      zip.readEntry()
    })
  })
}

async function readEpub(file: string): Promise<{ meta: BookMeta; cover: Buffer | null }> {
  const container = (await zipRead(file, (n) => n === 'META-INF/container.xml')).get('META-INF/container.xml')
  const opf = container ? opfPath(container.toString('utf8')) : null
  if (!opf) throw new Error('Not an EPUB')
  const opfXml = (await zipRead(file, (n) => n === opf)).get(opf)
  if (!opfXml) throw new Error('EPUB package missing')
  const meta = epubMeta(opfXml.toString('utf8'), opf, file)
  const cover = meta.coverPath ? ((await zipRead(file, (n) => n === meta.coverPath)).get(meta.coverPath) ?? null) : null
  return { meta, cover }
}

// --- PDF: its page count from the page tree, without a PDF library

function pdfPageCount(file: string): number | null {
  try {
    const size = statSync(file).size
    const fd = openSync(file, 'r')
    const read = (start: number, length: number): string => {
      const buf = Buffer.alloc(Math.min(length, size - start))
      readSync(fd, buf, 0, buf.length, start)
      return buf.toString('latin1')
    }
    // The root /Pages object carries the total; take the largest /Count seen.
    const text = size <= 16 * 1024 * 1024 ? read(0, size) : read(0, 4 * 1024 * 1024) + read(size - 4 * 1024 * 1024, 4 * 1024 * 1024)
    closeSync(fd)
    const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)].map((m) => parseInt(m[1] ?? m[2], 10))
    return counts.length ? Math.max(...counts) : null
  } catch {
    return null
  }
}

// --- Covers: any image, scaled to fit 600 px, as JPEG

async function saveCover(bookId: number, image: Buffer | string): Promise<void> {
  let source = typeof image === 'string' ? image : ''
  let tempDir: string | null = null
  if (typeof image !== 'string') {
    tempDir = mkdtempSync(join(tmpdir(), 'martbox-cover-'))
    source = join(tempDir, 'cover')
    writeFileSync(source, image)
  }
  const out = join(userDir('book-covers'), `${bookId}.jpg`)
  const tmp = `${out}.tmp.jpg`
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn(ffmpegPath, ['-v', 'error', '-y', '-i', source, '-frames:v', '1', '-vf', 'scale=600:600:force_original_aspect_ratio=decrease', '-q:v', '3', tmp])
    p.on('error', () => resolve(false))
    p.on('close', (code) => resolve(code === 0 && existsSync(tmp)))
  })
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  if (!ok) return
  renameSync(tmp, out)
  db.prepare('UPDATE books SET cover_path = ? WHERE id = ?').run(out, bookId)
}

// --- Scanning

function walk(dir: string, out: string[]): void {
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile() && formatOf(e.name)) out.push(p)
  }
}

// Books in Author/Title.epub folders: the folder names the author when the
// file doesn't.
function folderAuthor(file: string, root: string): string | null {
  const parent = dirname(file)
  return parent !== root ? basename(parent) : null
}

async function scanBook(library: Library, file: string, signature: string): Promise<void> {
  const format = formatOf(file) as BookFormat
  let meta: BookMeta
  let pages: string[] | null = null
  let pageCount: number | null = null
  let cover: Buffer | string | null = null
  let tempDir: string | null = null
  try {
    if (format === 'epub') {
      const epub = await readEpub(file)
      meta = epub.meta
      cover = epub.cover
    } else if (format === 'comic') {
      const entries = await archiveEntries(file)
      pages = comicPages(entries)
      pageCount = pages.length
      const info = entries.find((e) => /(^|\/)comicinfo\.xml$/i.test(e))
      tempDir = mkdtempSync(join(tmpdir(), 'martbox-comic-'))
      await extract(file, tempDir, [info, pages[0]].filter((n): n is string => !!n))
      const infoFile = info ? join(tempDir, info) : null
      meta = infoFile && existsSync(infoFile) ? comicInfoMeta(readFileSync(infoFile, 'utf8'), file) : comicNameMeta(file)
      if (pages[0] && existsSync(join(tempDir, pages[0]))) cover = join(tempDir, pages[0])
    } else {
      meta = { title: basename(file, extname(file)), author: null, series: null, seriesIndex: null, year: null, description: null }
      pageCount = pdfPageCount(file)
    }
    // Comics' folders name series or publishers, not writers.
    if (format !== 'comic') meta.author = meta.author ?? folderAuthor(file, library.path)
    const existing = db.prepare('SELECT id FROM books WHERE file_path = ?').get(file) as { id: number } | undefined
    const values = [library.id, format, meta.title, sortKey(meta.title), meta.author, sortKey(meta.author ?? ''), meta.series, meta.seriesIndex,
      meta.year, meta.description, pages ? JSON.stringify(pages) : null, pageCount, signature]
    let id: number
    if (existing) {
      id = existing.id
      db.prepare(
        `UPDATE books SET library_id = ?, format = ?, title = ?, sort_title = ?, author = ?, sort_author = ?, series = ?, series_index = ?,
           year = ?, description = ?, pages = ?, page_count = ?, signature = ? WHERE id = ?`
      ).run(...values, id)
      // Pages may have moved: unpack again when next read.
      rmSync(join(userDir('comic-cache'), String(id)), { recursive: true, force: true })
    } else {
      id = Number(
        db.prepare(
          `INSERT INTO books (library_id, format, title, sort_title, author, sort_author, series, series_index, year, description, pages,
             page_count, signature, file_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(...values, file).lastInsertRowid
      )
    }
    if (cover) await saveCover(id, cover)
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  }
}

export async function scanBookLibrary(library: Library, onProgress: (p: ScanProgress) => void): Promise<void> {
  onProgress({ libraryId: library.id, phase: 'scanning', current: 0, total: 0, message: 'Finding books and comics…' })
  const files: string[] = []
  walk(library.path, files)
  const known = new Map(
    (db.prepare('SELECT file_path, signature FROM books WHERE library_id = ?').all(library.id) as { file_path: string; signature: string }[]).map(
      (r) => [r.file_path, r.signature]
    )
  )
  const todo = files
    .map((f) => {
      try {
        const st = statSync(f)
        return { file: f, signature: `${st.size}|${Math.round(st.mtimeMs)}` }
      } catch {
        return null
      }
    })
    .filter((x): x is { file: string; signature: string } => x !== null && known.get(x.file) !== x.signature)
  let done = 0
  for (const item of todo) {
    try {
      await scanBook(library, item.file, item.signature)
    } catch {
      /* unreadable file: tried again next scan */
    }
    done++
    onProgress({ libraryId: library.id, phase: 'matching', current: done, total: todo.length, message: basename(item.file) })
  }
  const found = new Set(files)
  const remove = db.prepare('DELETE FROM books WHERE file_path = ?')
  db.transaction(() => [...known.keys()].filter((p) => !found.has(p)).forEach((p) => remove.run(p)))()
  onProgress({ libraryId: library.id, phase: 'done', current: 1, total: 1, message: 'Done' })
}

// --- Reading

function toBook(r: any): Book {
  return {
    id: r.id,
    format: r.format,
    title: r.title,
    author: r.author ?? null,
    series: r.series ?? null,
    seriesIndex: r.series_index ?? null,
    year: r.year ?? null,
    pageCount: r.page_count ?? null,
    hasCover: !!r.cover_path,
    addedAt: r.added_at
  }
}

export function listBooks(): Book[] {
  return (db.prepare('SELECT * FROM books ORDER BY sort_author, series, CAST(series_index AS REAL), sort_title').all() as any[]).map(toBook)
}

export function getBook(id: number): BookDetail | null {
  const r = db.prepare('SELECT * FROM books WHERE id = ?').get(id) as any
  return r ? { ...toBook(r), description: r.description ?? null } : null
}

const COMIC_CACHE_LIMIT = 3 * 1024 * 1024 * 1024
const unpacking = new Map<number, Promise<string | null>>()

function folderSize(dir: string): number {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? folderSize(p) : statSync(p).size
  }
  return total
}

// Keeps the unpacked comics under the limit, dropping the least recently read.
function trimComicCache(keep: number): void {
  const root = userDir('comic-cache')
  const dirs = readdirSync(root)
    .map((name) => ({ name, path: join(root, name) }))
    .filter((d) => d.name !== String(keep))
    .map((d) => ({ ...d, size: folderSize(d.path), used: statSync(d.path).mtimeMs }))
    .sort((a, b) => a.used - b.used)
  let total = dirs.reduce((s, d) => s + d.size, 0)
  for (const d of dirs) {
    if (total <= COMIC_CACHE_LIMIT) break
    rmSync(d.path, { recursive: true, force: true })
    total -= d.size
  }
}

// A comic unpacked into the cache (once), for its pages.
function unpackedComic(id: number, file: string): Promise<string | null> {
  const dir = join(userDir('comic-cache'), String(id))
  if (existsSync(join(dir, '.done'))) {
    const now = new Date()
    utimesSync(dir, now, now)
    return Promise.resolve(dir)
  }
  const running = unpacking.get(id)
  if (running) return running
  const job = (async () => {
    rmSync(dir, { recursive: true, force: true })
    if (!(await extract(file, dir))) return null
    writeFileSync(join(dir, '.done'), '')
    trimComicCache(id)
    return dir
  })().finally(() => unpacking.delete(id))
  unpacking.set(id, job)
  return job
}

export function listProgress(profileId: number): BookProgress[] {
  return (
    db.prepare('SELECT * FROM book_progress WHERE profile_id = ? ORDER BY updated_at DESC').all(profileId) as any[]
  ).map((r) => ({ bookId: r.book_id, locator: r.locator, fraction: r.fraction, finished: !!r.finished, updatedAt: r.updated_at }))
}

export function saveProgress(profileId: number, bookId: number, locator: string, fraction: number, finished: boolean): boolean {
  if (!db.prepare('SELECT 1 FROM books WHERE id = ?').get(bookId)) return false
  db.prepare(
    `INSERT INTO book_progress (profile_id, book_id, locator, fraction, finished, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (profile_id, book_id) DO UPDATE SET locator = excluded.locator, fraction = excluded.fraction, finished = excluded.finished,
       updated_at = excluded.updated_at`
  ).run(profileId, bookId, locator.slice(0, 2000), Math.max(0, Math.min(1, fraction)), finished ? 1 : 0)
  return true
}

// --- HTTP

type CanAct = (res: Response, profileId: number, pin: string | undefined) => boolean

const MIME: Record<string, string> = { epub: 'application/epub+zip', pdf: 'application/pdf' }
const IMAGE_MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' }

export function registerBookRoutes(app: Express, canActAsProfile: CanAct): void {
  const json = express.json({ limit: '16kb' })
  const id = (req: Request): number => parseInt(req.params.id, 10)
  const row = (req: Request): any => db.prepare('SELECT * FROM books WHERE id = ?').get(id(req))

  app.get('/api/books', (_req, res) => res.json(listBooks()))

  // Before /:id, which would take "progress" as an id.
  app.get('/api/books/progress', (req, res) => {
    const profileId = parseInt(String(req.query.profileId), 10)
    if (!canActAsProfile(res, profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    res.json(listProgress(profileId))
  })

  app.get('/api/books/:id', (req, res) => {
    const book = getBook(id(req))
    if (book) res.json(book)
    else res.status(404).json({ error: 'No such book' })
  })

  app.get('/api/books/:id/cover', (req, res) => {
    const r = row(req)
    if (!r?.cover_path || !existsSync(r.cover_path)) {
      res.status(404).end()
      return
    }
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.sendFile(r.cover_path)
  })

  // The EPUB or PDF itself, for the reader in the app.
  app.get('/api/books/:id/file', (req, res) => {
    const r = row(req)
    if (!r || r.format === 'comic' || !existsSync(r.file_path)) {
      res.status(404).end()
      return
    }
    res.sendFile(r.file_path, { headers: { 'Content-Type': MIME[r.format], 'Cache-Control': 'private, max-age=3600' } })
  })

  // A comic's page (0 = the first).
  app.get('/api/books/:id/pages/:page', async (req, res) => {
    const r = row(req)
    const page = parseInt(req.params.page, 10)
    const pages: string[] = r?.pages ? JSON.parse(r.pages) : []
    if (!r || r.format !== 'comic' || !(page >= 0 && page < pages.length) || !existsSync(r.file_path)) {
      res.status(404).end()
      return
    }
    const dir = await unpackedComic(r.id, r.file_path)
    const file = dir ? join(dir, pages[page]) : null
    if (!file || !existsSync(file)) {
      res.status(500).json({ error: "Couldn't open this comic" })
      return
    }
    res.sendFile(file, {
      headers: { 'Content-Type': IMAGE_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' }
    })
  })

  app.post('/api/books/:id/progress', json, (req, res) => {
    const { profileId, pin, locator, fraction, finished } = req.body ?? {}
    if (!canActAsProfile(res, profileId, pin)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    if (typeof locator !== 'string' || !Number.isFinite(Number(fraction))) {
      res.status(400).json({ error: 'locator (text) and fraction (0–1) are needed' })
      return
    }
    if (saveProgress(profileId, id(req), locator, Number(fraction), !!finished)) res.json({ ok: true })
    else res.status(404).json({ error: 'No such book' })
  })
}
