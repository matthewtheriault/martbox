import { app } from 'electron'
import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { join, extname, dirname } from 'path'
import express from 'express'
import type { Express, Request, Response } from 'express'
import ffmpegStatic from 'ffmpeg-static'
// @ts-ignore - no types shipped
import ffprobeStatic from 'ffprobe-static'
import { db } from './db'
import { AUDIOBOOK_EXTENSIONS, bookChapters, bookMeta, groupBooks, probedFile, type ProbedFile } from './audiobooksCore'
import { sortKey } from './musicCore'
import type { Audiobook, AudiobookDetail, AudiobookProgress, Library, ScanProgress } from '../shared/types'

// Audiobooks (Phase 5): libraries of spoken-word books, a folder (or one
// .m4b) per book; chapters, covers, and each person's place in each book,
// synced across their devices. Clients play the book's files one after
// another on a single timeline.

const execFileAsync = promisify(execFile)
const ffmpegPath = (ffmpegStatic as string).replace('app.asar', 'app.asar.unpacked')
const ffprobePath = (ffprobeStatic.path as string).replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')

db.exec(`
  CREATE TABLE IF NOT EXISTS audiobooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    book_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    sort_title TEXT NOT NULL,
    author TEXT NOT NULL,
    sort_author TEXT NOT NULL,
    narrator TEXT,
    series TEXT,
    year INTEGER,
    description TEXT,
    duration REAL NOT NULL DEFAULT 0,
    chapters TEXT NOT NULL DEFAULT '[]',
    signature TEXT NOT NULL,
    cover_path TEXT,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS audiobook_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES audiobooks(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    duration REAL NOT NULL DEFAULT 0,
    codec TEXT,
    has_cover INTEGER NOT NULL DEFAULT 0,
    UNIQUE (book_id, idx)
  );
  CREATE TABLE IF NOT EXISTS audiobook_progress (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    book_id INTEGER NOT NULL REFERENCES audiobooks(id) ON DELETE CASCADE,
    position REAL NOT NULL DEFAULT 0,
    finished INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (profile_id, book_id)
  );
  CREATE INDEX IF NOT EXISTS idx_audiobook_files_book ON audiobook_files(book_id, idx);
`)

function userDir(name: string): string {
  const d = join(app.getPath('userData'), name)
  mkdirSync(d, { recursive: true })
  return d
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
    else if (e.isFile() && AUDIOBOOK_EXTENSIONS.has(extname(e.name).toLowerCase())) out.push(p)
  }
}

async function probe(file: string): Promise<any> {
  const { stdout } = await execFileAsync(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file],
    { maxBuffer: 32 * 1024 * 1024 }
  )
  return JSON.parse(stdout)
}

// What a book's files were last scanned as: unchanged books aren't probed again.
function signatureOf(files: string[]): string {
  return files
    .map((f) => {
      try {
        const st = statSync(f)
        return `${f}|${st.size}|${Math.round(st.mtimeMs)}`
      } catch {
        return `${f}|gone`
      }
    })
    .join('\n')
}

const FOLDER_COVERS = ['cover', 'folder', 'front', 'book']

async function saveCover(bookId: number, folder: string, embeddedIn: string | null): Promise<void> {
  let image: string | null = null
  try {
    const files = readdirSync(folder)
    const images = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    image =
      FOLDER_COVERS.map((n) => images.find((f) => f.replace(/\.[^.]+$/, '').toLowerCase() === n)).find(Boolean) ??
      // A book folder with one picture: that's the cover.
      (images.length === 1 ? images[0] : null) ??
      null
    if (image) image = join(folder, image)
  } catch {
    /* folder gone */
  }
  const source = image ?? embeddedIn
  if (!source) return
  const out = join(userDir('audiobook-covers'), `${bookId}.jpg`)
  const tmp = `${out}.tmp.jpg`
  // Book covers are portrait-ish or square: fit within 600 px, keep the shape.
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn(ffmpegPath, [
      '-v', 'error', '-y', '-i', source, '-an', '-map', '0:v:0', '-frames:v', '1',
      '-vf', 'scale=600:600:force_original_aspect_ratio=decrease', '-q:v', '3', tmp
    ])
    p.on('error', () => resolve(false))
    p.on('close', (code) => resolve(code === 0 && existsSync(tmp)))
  })
  if (!ok) return
  renameSync(tmp, out)
  db.prepare('UPDATE audiobooks SET cover_path = ? WHERE id = ?').run(out, bookId)
}

async function saveBook(libraryId: number, key: string, files: ProbedFile[], signature: string): Promise<void> {
  const meta = bookMeta({ key, files: files.map((f) => f.path) }, files[0])
  const duration = files.reduce((sum, f) => sum + f.durationSeconds, 0)
  const chapters = JSON.stringify(bookChapters(files))
  const existing = db.prepare('SELECT id FROM audiobooks WHERE book_key = ?').get(key) as { id: number } | undefined
  let bookId: number
  if (existing) {
    bookId = existing.id
    db.prepare(
      `UPDATE audiobooks SET library_id = ?, title = ?, sort_title = ?, author = ?, sort_author = ?, narrator = ?, series = ?,
         year = ?, description = ?, duration = ?, chapters = ?, signature = ? WHERE id = ?`
    ).run(libraryId, meta.title, sortKey(meta.title), meta.author, sortKey(meta.author), meta.narrator, meta.series,
      meta.year, meta.description, duration, chapters, signature, bookId)
  } else {
    bookId = Number(
      db.prepare(
        `INSERT INTO audiobooks (library_id, book_key, title, sort_title, author, sort_author, narrator, series, year,
           description, duration, chapters, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(libraryId, key, meta.title, sortKey(meta.title), meta.author, sortKey(meta.author), meta.narrator, meta.series,
        meta.year, meta.description, duration, chapters, signature).lastInsertRowid
    )
  }
  db.prepare('DELETE FROM audiobook_files WHERE book_id = ?').run(bookId)
  const insert = db.prepare('INSERT INTO audiobook_files (book_id, idx, file_path, duration, codec) VALUES (?, ?, ?, ?, ?)')
  files.forEach((f, i) => insert.run(bookId, i, f.path, f.durationSeconds, f.codec))
  const folder = files.length === 1 && key === files[0].path ? dirname(key) : key
  await saveCover(bookId, folder, files[0].path)
}

export async function scanAudiobookLibrary(library: Library, onProgress: (p: ScanProgress) => void): Promise<void> {
  onProgress({ libraryId: library.id, phase: 'scanning', current: 0, total: 0, message: 'Finding audiobooks…' })
  const files: string[] = []
  walk(library.path, files)
  const groups = groupBooks(files)
  const known = new Map(
    (db.prepare('SELECT book_key AS key, signature FROM audiobooks WHERE library_id = ?').all(library.id) as {
      key: string
      signature: string
    }[]).map((r) => [r.key, r.signature])
  )
  const todo = groups
    .map((g) => ({ ...g, signature: signatureOf(g.files) }))
    .filter((g) => known.get(g.key) !== g.signature)
  let done = 0
  for (const group of todo) {
    try {
      const probed: ProbedFile[] = []
      for (const f of group.files) probed.push(probedFile(f, await probe(f)))
      await saveBook(library.id, group.key, probed, group.signature)
    } catch {
      /* unreadable book: tried again next scan */
    }
    done++
    onProgress({ libraryId: library.id, phase: 'matching', current: done, total: todo.length, message: group.key.split(/[\\/]/).pop() ?? '' })
  }
  const keep = new Set(groups.map((g) => g.key))
  const gone = [...known.keys()].filter((k) => !keep.has(k))
  const remove = db.prepare('DELETE FROM audiobooks WHERE book_key = ?')
  db.transaction(() => gone.forEach((k) => remove.run(k)))()
  onProgress({ libraryId: library.id, phase: 'done', current: 1, total: 1, message: 'Done' })
}

// --- Reading

function toBook(r: any): Audiobook {
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    narrator: r.narrator ?? null,
    series: r.series ?? null,
    year: r.year ?? null,
    durationSeconds: r.duration ?? 0,
    hasCover: !!r.cover_path,
    addedAt: r.added_at
  }
}

export function listAudiobooks(): Audiobook[] {
  return (db.prepare('SELECT * FROM audiobooks ORDER BY sort_author, series, year, sort_title').all() as any[]).map(toBook)
}

export function getAudiobook(id: number): AudiobookDetail | null {
  const r = db.prepare('SELECT * FROM audiobooks WHERE id = ?').get(id) as any
  if (!r) return null
  const files = db.prepare('SELECT idx, duration, codec FROM audiobook_files WHERE book_id = ? ORDER BY idx').all(id) as {
    idx: number
    duration: number
    codec: string | null
  }[]
  let start = 0
  return {
    ...toBook(r),
    description: r.description ?? null,
    files: files.map((f) => {
      const file = { index: f.idx, start, durationSeconds: f.duration, codec: f.codec }
      start += f.duration
      return file
    }),
    chapters: JSON.parse(r.chapters)
  }
}

function bookFile(id: number, index: number): { path: string; codec: string | null } | null {
  const r = db.prepare('SELECT file_path AS path, codec FROM audiobook_files WHERE book_id = ? AND idx = ?').get(id, index) as
    | { path: string; codec: string | null }
    | undefined
  return r && existsSync(r.path) ? r : null
}

function coverPath(id: number): string | null {
  const r = db.prepare('SELECT cover_path FROM audiobooks WHERE id = ?').get(id) as { cover_path: string | null } | undefined
  return r?.cover_path && existsSync(r.cover_path) ? r.cover_path : null
}

// Files a device can't play as they are (Opus on Apple, say) are converted
// once to AAC at a speech-friendly 96 kbps and kept, like music's copies.
const converting = new Map<string, Promise<string | null>>()

function aacCopy(id: number, index: number, source: string): Promise<string | null> {
  const out = join(userDir('audiobook-cache'), `${id}-${index}.m4a`)
  if (existsSync(out)) return Promise.resolve(out)
  const running = converting.get(out)
  if (running) return running
  const tmp = `${out}.part.m4a`
  const job = new Promise<string | null>((resolve) => {
    const p = spawn(ffmpegPath, ['-v', 'error', '-y', '-i', source, '-vn', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', tmp])
    p.on('error', () => resolve(null))
    p.on('close', (code) => {
      if (code === 0 && existsSync(tmp)) {
        renameSync(tmp, out)
        resolve(out)
      } else {
        rmSync(tmp, { force: true })
        resolve(null)
      }
    })
  }).finally(() => converting.delete(out))
  converting.set(out, job)
  return job
}

// --- Each person's place in each book

export function listProgress(profileId: number): AudiobookProgress[] {
  return (
    db
      .prepare('SELECT book_id, position, finished, updated_at FROM audiobook_progress WHERE profile_id = ? ORDER BY updated_at DESC')
      .all(profileId) as { book_id: number; position: number; finished: number; updated_at: string }[]
  ).map((r) => ({ bookId: r.book_id, positionSeconds: r.position, finished: !!r.finished, updatedAt: r.updated_at }))
}

export function saveProgress(profileId: number, bookId: number, position: number, finished: boolean): boolean {
  const book = db.prepare('SELECT duration FROM audiobooks WHERE id = ?').get(bookId) as { duration: number } | undefined
  if (!book) return false
  const clamped = Math.max(0, Math.min(position, book.duration || position))
  db.prepare(
    `INSERT INTO audiobook_progress (profile_id, book_id, position, finished, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (profile_id, book_id) DO UPDATE SET position = excluded.position, finished = excluded.finished, updated_at = excluded.updated_at`
  ).run(profileId, bookId, clamped, finished ? 1 : 0)
  return true
}

// --- HTTP

type CanAct = (res: Response, profileId: number, pin: string | undefined) => boolean

export function registerAudiobookRoutes(app: Express, canActAsProfile: CanAct): void {
  const json = express.json({ limit: '16kb' })
  const id = (req: Request): number => parseInt(req.params.id, 10)

  app.get('/api/audiobooks', (_req, res) => res.json(listAudiobooks()))

  // Before /:id, which would take "progress" as an id.
  app.get('/api/audiobooks/progress', (req, res) => {
    const profileId = parseInt(String(req.query.profileId), 10)
    if (!canActAsProfile(res, profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    res.json(listProgress(profileId))
  })

  app.get('/api/audiobooks/:id', (req, res) => {
    const book = getAudiobook(id(req))
    if (book) res.json(book)
    else res.status(404).json({ error: 'No such audiobook' })
  })

  app.get('/api/audiobooks/:id/cover', (req, res) => {
    const file = coverPath(id(req))
    if (!file) {
      res.status(404).end()
      return
    }
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.sendFile(file)
  })

  // One of the book's files. `accepts` lists the codecs this device plays
  // (aac, mp3, opus, vorbis, flac…); anything else comes as AAC.
  app.get('/api/audiobooks/:id/files/:index/stream', async (req, res) => {
    const file = bookFile(id(req), parseInt(req.params.index, 10))
    if (!file) {
      res.status(404).end()
      return
    }
    const accepts = String(req.query.accepts ?? 'aac,mp3').split(',').map((s) => s.trim())
    const playable = file.codec !== null && accepts.includes(file.codec)
    const path = playable ? file.path : await aacCopy(id(req), parseInt(req.params.index, 10), file.path)
    if (!path) {
      res.status(500).json({ error: "Couldn't convert this part of the book" })
      return
    }
    // .m4b is MP4 audio; say so, or some players won't take it.
    const type = /\.(m4b|m4a)$/i.test(path) ? 'audio/mp4' : undefined
    res.sendFile(path, { headers: { 'Cache-Control': 'private, max-age=3600', ...(type ? { 'Content-Type': type } : {}) } })
  })

  app.post('/api/audiobooks/:id/progress', json, (req, res) => {
    const { profileId, pin, positionSeconds, finished } = req.body ?? {}
    if (!canActAsProfile(res, profileId, pin)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    const position = Number(positionSeconds)
    if (!Number.isFinite(position)) {
      res.status(400).json({ error: 'positionSeconds must be a number' })
      return
    }
    if (saveProgress(profileId, id(req), position, !!finished)) res.json({ ok: true })
    else res.status(404).json({ error: 'No such audiobook' })
  })
}
