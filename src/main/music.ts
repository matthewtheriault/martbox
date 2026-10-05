import { app } from 'electron'
import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'fs'
import { join, extname, dirname } from 'path'
import ffmpegStatic from 'ffmpeg-static'
// @ts-ignore - no types shipped
import ffprobeStatic from 'ffprobe-static'
import type { Express, Request } from 'express'
import { db } from './db'
import { AUDIO_EXTENSIONS, LOSSLESS_CODECS, parseTrack, sortKey, splitGenres, type TrackTags } from './musicCore'
import type { Library, MusicAlbum, MusicAlbumDetail, MusicArtist, MusicGenre, MusicSearchResults, MusicTrack, ScanProgress } from '../shared/types'

// Music (Phase 4): libraries of audio files, read into artists, albums and
// tracks by their tags; album art from the folder or the files; streaming
// the original (lossless at home) or a cached AAC copy when the device or
// the connection needs it.

const execFileAsync = promisify(execFile)
const ffmpegPath = (ffmpegStatic as string).replace('app.asar', 'app.asar.unpacked')
const ffprobePath = (ffprobeStatic.path as string).replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')

db.exec(`
  CREATE TABLE IF NOT EXISTS music_artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    sort_name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS music_albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_id INTEGER NOT NULL REFERENCES music_artists(id) ON DELETE CASCADE,
    title TEXT NOT NULL COLLATE NOCASE,
    sort_title TEXT NOT NULL,
    year INTEGER,
    cover_path TEXT,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (artist_id, title)
  );
  CREATE TABLE IF NOT EXISTS music_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    album_id INTEGER NOT NULL REFERENCES music_albums(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL UNIQUE,
    mtime_ms INTEGER NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    track_no INTEGER,
    disc_no INTEGER NOT NULL DEFAULT 1,
    duration REAL NOT NULL DEFAULT 0,
    codec TEXT,
    sample_rate INTEGER,
    bit_depth INTEGER,
    channels INTEGER,
    bitrate_kbps INTEGER,
    genre TEXT,
    track_gain REAL,
    album_gain REAL,
    has_cover INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_music_tracks_album ON music_tracks(album_id);
  CREATE INDEX IF NOT EXISTS idx_music_albums_artist ON music_albums(artist_id);
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
    else if (e.isFile() && AUDIO_EXTENSIONS.has(extname(e.name).toLowerCase())) out.push(p)
  }
}

async function probe(file: string): Promise<any> {
  const { stdout } = await execFileAsync(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { maxBuffer: 16 * 1024 * 1024 }
  )
  return JSON.parse(stdout)
}

function artistId(name: string): number {
  const found = db.prepare('SELECT id FROM music_artists WHERE name = ?').get(name) as { id: number } | undefined
  if (found) return found.id
  return Number(db.prepare('INSERT INTO music_artists (name, sort_name) VALUES (?, ?)').run(name, sortKey(name)).lastInsertRowid)
}

function albumId(artist: number, title: string, year: number | null): number {
  const found = db
    .prepare('SELECT id, year FROM music_albums WHERE artist_id = ? AND title = ?')
    .get(artist, title) as { id: number; year: number | null } | undefined
  if (found) {
    if (!found.year && year) db.prepare('UPDATE music_albums SET year = ? WHERE id = ?').run(year, found.id)
    return found.id
  }
  return Number(
    db
      .prepare('INSERT INTO music_albums (artist_id, title, sort_title, year) VALUES (?, ?, ?, ?)')
      .run(artist, title, sortKey(title), year).lastInsertRowid
  )
}

function saveTrack(libraryId: number, file: string, mtimeMs: number, t: TrackTags): void {
  const album = albumId(artistId(t.albumArtist), t.album, t.year)
  db.prepare(
    `INSERT INTO music_tracks (library_id, album_id, file_path, mtime_ms, title, artist, track_no, disc_no, duration,
       codec, sample_rate, bit_depth, channels, bitrate_kbps, genre, track_gain, album_gain, has_cover)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET library_id = excluded.library_id, album_id = excluded.album_id,
       mtime_ms = excluded.mtime_ms, title = excluded.title, artist = excluded.artist, track_no = excluded.track_no,
       disc_no = excluded.disc_no, duration = excluded.duration, codec = excluded.codec,
       sample_rate = excluded.sample_rate, bit_depth = excluded.bit_depth, channels = excluded.channels,
       bitrate_kbps = excluded.bitrate_kbps, genre = excluded.genre, track_gain = excluded.track_gain,
       album_gain = excluded.album_gain, has_cover = excluded.has_cover`
  ).run(
    libraryId, album, file, Math.round(mtimeMs), t.title, t.artist, t.trackNumber, t.discNumber, t.durationSeconds,
    t.codec, t.sampleRate, t.bitDepth, t.channels, t.bitrateKbps, t.genre, t.trackGain, t.albumGain, t.hasEmbeddedCover ? 1 : 0
  )
}

// Albums and artists left with nothing in them.
function pruneEmpty(): void {
  const gone = db
    .prepare('SELECT id, cover_path FROM music_albums WHERE id NOT IN (SELECT DISTINCT album_id FROM music_tracks)')
    .all() as { id: number; cover_path: string | null }[]
  for (const a of gone) if (a.cover_path?.startsWith(userDir('music-covers'))) rmSync(a.cover_path, { force: true })
  db.exec('DELETE FROM music_albums WHERE id NOT IN (SELECT DISTINCT album_id FROM music_tracks)')
  db.exec('DELETE FROM music_artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM music_albums)')
}

const FOLDER_COVERS = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall']

// Album art: an image in the album's folder, else the first embedded one.
async function findCovers(): Promise<void> {
  const albums = db
    .prepare(
      `SELECT a.id, MIN(t.file_path) AS file, MAX(t.has_cover) AS embedded FROM music_albums a
       JOIN music_tracks t ON t.album_id = a.id WHERE a.cover_path IS NULL GROUP BY a.id`
    )
    .all() as { id: number; file: string; embedded: number }[]
  for (const a of albums) {
    const folder = dirname(a.file)
    let image: string | null = null
    try {
      const files = readdirSync(folder)
      for (const name of FOLDER_COVERS) {
        const hit = files.find((f) => /\.(jpe?g|png|webp)$/i.test(f) && f.replace(/\.[^.]+$/, '').toLowerCase() === name)
        if (hit) {
          image = join(folder, hit)
          break
        }
      }
    } catch {
      /* folder gone: no cover */
    }
    const out = join(userDir('music-covers'), `${a.id}.jpg`)
    const source = image ?? (a.embedded ? a.file : null)
    if (!source) continue
    // One size for every screen (600 px), as JPEG.
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn(ffmpegPath, [
        '-v', 'error', '-y', '-i', source, '-an', '-map', '0:v:0', '-frames:v', '1',
        '-vf', 'scale=600:600:force_original_aspect_ratio=increase,crop=600:600', '-q:v', '3', out
      ])
      p.on('error', () => resolve(false))
      p.on('close', (code) => resolve(code === 0 && existsSync(out)))
    })
    if (ok) db.prepare('UPDATE music_albums SET cover_path = ? WHERE id = ?').run(out, a.id)
  }
}

export async function scanMusicLibrary(library: Library, onProgress: (p: ScanProgress) => void): Promise<void> {
  onProgress({ libraryId: library.id, phase: 'scanning', current: 0, total: 0, message: 'Finding music…' })
  const files: string[] = []
  walk(library.path, files)
  const known = new Map(
    (db.prepare('SELECT file_path, mtime_ms FROM music_tracks WHERE library_id = ?').all(library.id) as {
      file_path: string
      mtime_ms: number
    }[]).map((r) => [r.file_path, r.mtime_ms])
  )
  const found = new Set(files)
  const todo = files
    .map((f) => {
      try {
        return { file: f, mtime: statSync(f).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((x): x is { file: string; mtime: number } => x !== null && known.get(x.file) !== Math.round(x.mtime))

  let done = 0
  const next = async (): Promise<void> => {
    for (let item = todo.shift(); item; item = todo.shift()) {
      try {
        saveTrack(library.id, item.file, item.mtime, parseTrack(item.file, await probe(item.file)))
      } catch {
        /* unreadable file: skipped, tried again next scan */
      }
      done++
      if (done % 10 === 0 || todo.length === 0) {
        onProgress({ libraryId: library.id, phase: 'matching', current: done, total: done + todo.length, message: item.file.split(/[\\/]/).pop() ?? '' })
      }
    }
  }
  await Promise.all([next(), next(), next(), next()])

  const remove = db.prepare('DELETE FROM music_tracks WHERE file_path = ?')
  db.transaction(() => {
    for (const path of known.keys()) if (!found.has(path)) remove.run(path)
  })()
  pruneEmpty()
  await findCovers()
  onProgress({ libraryId: library.id, phase: 'done', current: 1, total: 1, message: 'Done' })
}

// --- Reading

const ALBUM_SELECT = `
  SELECT al.id, al.title, al.year, al.added_at AS addedAt, al.cover_path IS NOT NULL AS hasCover,
    ar.id AS artistId, ar.name AS artist,
    COUNT(t.id) AS trackCount, SUM(t.duration) AS durationSeconds,
    MIN(CASE WHEN t.codec IN (${[...LOSSLESS_CODECS].map((c) => `'${c}'`).join(',')}) THEN 1 ELSE 0 END) AS lossless,
    MAX(t.sample_rate) AS sampleRate, MAX(t.bit_depth) AS bitDepth
  FROM music_albums al
  JOIN music_artists ar ON ar.id = al.artist_id
  JOIN music_tracks t ON t.album_id = al.id`

function toAlbum(r: any): MusicAlbum {
  return {
    id: r.id,
    title: r.title,
    artistId: r.artistId,
    artist: r.artist,
    year: r.year ?? null,
    trackCount: r.trackCount,
    durationSeconds: r.durationSeconds ?? 0,
    hasCover: !!r.hasCover,
    lossless: !!r.lossless,
    sampleRate: r.sampleRate ?? null,
    bitDepth: r.bitDepth ?? null,
    addedAt: r.addedAt
  }
}

const TRACK_SELECT = `
  SELECT t.id, t.title, t.artist, t.track_no AS trackNumber, t.disc_no AS discNumber, t.duration AS durationSeconds,
    t.codec, t.sample_rate AS sampleRate, t.bit_depth AS bitDepth, t.bitrate_kbps AS bitrateKbps,
    t.track_gain AS trackGain, t.album_gain AS albumGain, t.genre,
    al.id AS albumId, al.title AS album, al.cover_path IS NOT NULL AS hasCover, ar.name AS albumArtist
  FROM music_tracks t
  JOIN music_albums al ON al.id = t.album_id
  JOIN music_artists ar ON ar.id = al.artist_id`

function toTrack(r: any): MusicTrack {
  return {
    id: r.id,
    title: r.title,
    artist: r.artist,
    albumArtist: r.albumArtist,
    albumId: r.albumId,
    album: r.album,
    trackNumber: r.trackNumber ?? null,
    discNumber: r.discNumber ?? 1,
    durationSeconds: r.durationSeconds ?? 0,
    codec: r.codec ?? null,
    lossless: LOSSLESS_CODECS.has(r.codec ?? ''),
    sampleRate: r.sampleRate ?? null,
    bitDepth: r.bitDepth ?? null,
    bitrateKbps: r.bitrateKbps ?? null,
    trackGain: r.trackGain ?? null,
    albumGain: r.albumGain ?? null,
    genre: r.genre ?? null,
    hasCover: !!r.hasCover
  }
}

export function listArtists(): MusicArtist[] {
  return (
    db
      .prepare(
        `SELECT ar.id, ar.name, COUNT(DISTINCT al.id) AS albumCount,
           (SELECT a2.id FROM music_albums a2 WHERE a2.artist_id = ar.id AND a2.cover_path IS NOT NULL
            ORDER BY a2.year DESC LIMIT 1) AS coverAlbumId
         FROM music_artists ar JOIN music_albums al ON al.artist_id = ar.id
         GROUP BY ar.id ORDER BY ar.sort_name`
      )
      .all() as any[]
  ).map((r) => ({ id: r.id, name: r.name, albumCount: r.albumCount, coverAlbumId: r.coverAlbumId ?? null }))
}

export function listAlbums(artistId?: number, genre?: string): MusicAlbum[] {
  const rows = artistId
    ? db.prepare(`${ALBUM_SELECT} WHERE al.artist_id = ? GROUP BY al.id ORDER BY al.year DESC, al.sort_title`).all(artistId)
    : db.prepare(`${ALBUM_SELECT} GROUP BY al.id ORDER BY ar.sort_name, al.year, al.sort_title`).all()
  const albums = (rows as any[]).map(toAlbum)
  if (!genre) return albums
  const ids = genreIndex().get(genre.toLowerCase())?.albumIds ?? new Set<number>()
  return albums.filter((a) => ids.has(a.id))
}

// Every genre named in the tracks' tags, with the albums that have it.
function genreIndex(): Map<string, { name: string; albumIds: Set<number>; trackCount: number }> {
  const rows = db.prepare('SELECT album_id AS albumId, genre FROM music_tracks WHERE genre IS NOT NULL').all() as {
    albumId: number
    genre: string
  }[]
  const index = new Map<string, { name: string; albumIds: Set<number>; trackCount: number }>()
  for (const r of rows) {
    for (const name of splitGenres(r.genre)) {
      const key = name.toLowerCase()
      const entry = index.get(key) ?? { name, albumIds: new Set<number>(), trackCount: 0 }
      entry.albumIds.add(r.albumId)
      entry.trackCount++
      index.set(key, entry)
    }
  }
  return index
}

export function listGenres(): MusicGenre[] {
  const covered = new Set(
    (db.prepare('SELECT id FROM music_albums WHERE cover_path IS NOT NULL').all() as { id: number }[]).map((r) => r.id)
  )
  return [...genreIndex().values()]
    .map((g) => ({
      name: g.name,
      albumCount: g.albumIds.size,
      trackCount: g.trackCount,
      coverAlbumId: [...g.albumIds].find((id) => covered.has(id)) ?? null
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function getAlbum(id: number): MusicAlbumDetail | null {
  const row = db.prepare(`${ALBUM_SELECT} WHERE al.id = ? GROUP BY al.id`).get(id)
  if (!row) return null
  const tracks = (db.prepare(`${TRACK_SELECT} WHERE t.album_id = ? ORDER BY t.disc_no, t.track_no, t.title`).all(id) as any[]).map(toTrack)
  return { ...toAlbum(row), tracks }
}

export function getTrack(id: number): MusicTrack | null {
  const row = db.prepare(`${TRACK_SELECT} WHERE t.id = ?`).get(id)
  return row ? toTrack(row) : null
}

// Songs and albums by id, for playlists and listening history (ids that
// no longer exist are simply missing).
export function tracksByIds(ids: number[]): Map<number, MusicTrack> {
  const unique = [...new Set(ids)]
  const out = new Map<number, MusicTrack>()
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500)
    const rows = db.prepare(`${TRACK_SELECT} WHERE t.id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as any[]
    for (const r of rows) out.set(r.id, toTrack(r))
  }
  return out
}

export function albumsByIds(ids: number[]): Map<number, MusicAlbum> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = db
    .prepare(`${ALBUM_SELECT} WHERE al.id IN (${unique.map(() => '?').join(',')}) GROUP BY al.id`)
    .all(...unique) as any[]
  return new Map(rows.map((r) => [r.id, toAlbum(r)]))
}

export function listTracks(limit = 500): MusicTrack[] {
  return (db.prepare(`${TRACK_SELECT} ORDER BY ar.sort_name, al.year, al.sort_title, t.disc_no, t.track_no LIMIT ?`).all(limit) as any[]).map(toTrack)
}

export function searchMusic(query: string): MusicSearchResults {
  const like = `%${query.trim().replace(/[%_]/g, '')}%`
  if (like === '%%') return { artists: [], albums: [], tracks: [] }
  const artists = (
    db.prepare(`SELECT ar.id, ar.name, COUNT(al.id) AS albumCount, NULL AS coverAlbumId FROM music_artists ar
       JOIN music_albums al ON al.artist_id = ar.id WHERE ar.name LIKE ? GROUP BY ar.id ORDER BY ar.sort_name LIMIT 20`).all(like) as any[]
  ).map((r) => ({ id: r.id, name: r.name, albumCount: r.albumCount, coverAlbumId: null }))
  const albums = (db.prepare(`${ALBUM_SELECT} WHERE al.title LIKE ? GROUP BY al.id ORDER BY al.sort_title LIMIT 30`).all(like) as any[]).map(toAlbum)
  const tracks = (db.prepare(`${TRACK_SELECT} WHERE t.title LIKE ? OR t.artist LIKE ? ORDER BY t.title LIMIT 50`).all(like, like) as any[]).map(toTrack)
  return { artists, albums, tracks }
}

export function albumCoverPath(id: number): string | null {
  const row = db.prepare('SELECT cover_path FROM music_albums WHERE id = ?').get(id) as { cover_path: string | null } | undefined
  return row?.cover_path && existsSync(row.cover_path) ? row.cover_path : null
}

// --- Streaming

export const AAC_KBPS = 256
const CACHE_LIMIT_BYTES = 4 * 1024 ** 3
const converting = new Map<string, Promise<string | null>>()

export function trackFile(id: number): { path: string; codec: string | null; bitrateKbps: number | null } | null {
  const row = db.prepare('SELECT file_path, codec, bitrate_kbps FROM music_tracks WHERE id = ?').get(id) as
    | { file_path: string; codec: string | null; bitrate_kbps: number | null }
    | undefined
  return row ? { path: row.file_path, codec: row.codec, bitrateKbps: row.bitrate_kbps } : null
}

// Whole-file AAC in M4A (not a live pipe): the encoder delay is written
// into the file, so players can join tracks without a gap, and it's
// seekable. Cached, oldest dropped past CACHE_LIMIT_BYTES.
export function aacCopy(id: number): Promise<string | null> {
  return convertedCopy(id, 'aac')
}

// Lossless for Apple devices: their player streams ALAC but not FLAC, so
// FLAC (and other lossless) becomes ALAC in M4A — the same audio, bit for
// bit.
export function alacCopy(id: number): Promise<string | null> {
  return convertedCopy(id, 'alac')
}

function convertedCopy(id: number, kind: 'aac' | 'alac'): Promise<string | null> {
  const src = trackFile(id)
  if (!src) return Promise.resolve(null)
  const out = join(userDir('music-cache'), kind === 'aac' ? `${id}-aac${AAC_KBPS}.m4a` : `${id}-alac.m4a`)
  if (existsSync(out)) {
    const now = new Date()
    try {
      utimesSync(out, now, now)
    } catch {
      /* fine */
    }
    return Promise.resolve(out)
  }
  const key = `${id}:${kind}`
  const pending = converting.get(key)
  if (pending) return pending
  const job = new Promise<string | null>((resolve) => {
    const tmp = `${out}.part`
    const p = spawn(ffmpegPath, [
      '-v', 'error', '-y', '-i', src.path, '-vn', '-map', '0:a:0',
      ...(kind === 'aac' ? ['-c:a', 'aac', '-b:a', `${AAC_KBPS}k`] : ['-c:a', 'alac']),
      '-movflags', '+faststart', '-f', 'mp4', tmp
    ])
    p.on('error', () => resolve(null))
    p.on('close', (code) => {
      if (code === 0) {
        renameSync(tmp, out)
        trimCache()
        resolve(out)
      } else {
        rmSync(tmp, { force: true })
        resolve(null)
      }
    })
  }).finally(() => converting.delete(key))
  converting.set(key, job)
  return job
}

function trimCache(): void {
  const dir = userDir('music-cache')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.m4a'))
    .map((f) => {
      const s = statSync(join(dir, f))
      return { path: join(dir, f), size: s.size, used: s.atimeMs }
    })
    .sort((a, b) => b.used - a.used)
  let total = 0
  for (const f of files) {
    total += f.size
    if (total > CACHE_LIMIT_BYTES) rmSync(f.path, { force: true })
  }
}

export type MusicFormat = 'original' | 'alac' | 'aac'

// The original when the device plays its codec, lossless ALAC when it
// doesn't but plays ALAC (Apple devices and FLAC), else AAC — and AAC
// whenever, away from home, the connection can't carry lossless.
export function chooseFormat(
  track: { codec: string | null; bitrateKbps: number | null },
  accepts: string[],
  bandwidthKbps: number | null
): MusicFormat {
  const codec = track.codec ?? ''
  if (bandwidthKbps && track.bitrateKbps && track.bitrateKbps * 1.3 > bandwidthKbps) return 'aac'
  if (accepts.includes(codec) || (codec.startsWith('pcm_') && accepts.includes('wav'))) return 'original'
  if (LOSSLESS_CODECS.has(codec) && accepts.includes('alac')) return 'alac'
  return 'aac'
}

// --- HTTP (mediaServer.ts registers these)

export function registerMusicRoutes(app: Express, isRemote: (req: Request) => boolean): void {
  const id = (req: Request): number => parseInt(req.params.id, 10)
  app.get('/api/music/artists', (_req, res) => res.json(listArtists()))
  app.get('/api/music/albums', (req, res) => {
    const artistId = parseInt(req.query.artistId as string, 10)
    const genre = typeof req.query.genre === 'string' && req.query.genre ? req.query.genre : undefined
    res.json(listAlbums(Number.isInteger(artistId) ? artistId : undefined, genre))
  })
  app.get('/api/music/genres', (_req, res) => res.json(listGenres()))
  app.get('/api/music/albums/:id', (req, res) => {
    const album = getAlbum(id(req))
    if (album) res.json(album)
    else res.status(404).json({ error: 'No such album' })
  })
  app.get('/api/music/tracks', (req, res) => {
    const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit as string, 10) || 500))
    res.json(listTracks(limit))
  })
  app.get('/api/music/search', (req, res) => res.json(searchMusic(String(req.query.q ?? ''))))
  app.get('/api/music/albums/:id/cover', (req, res) => {
    const file = albumCoverPath(id(req))
    if (!file) {
      res.status(404).end()
      return
    }
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.sendFile(file)
  })

  // How a track will play for this device: `accepts` lists the codecs it
  // decodes (flac, alac, mp3, aac, opus, vorbis, wav); away from home the
  // connection's speed counts too.
  const decide = (req: Request): { format: MusicFormat; track: MusicTrack } | null => {
    const track = getTrack(id(req))
    const file = trackFile(id(req))
    if (!track || !file) return null
    const accepts = String(req.query.accepts ?? 'mp3,aac').split(',').map((s) => s.trim())
    const kbps = parseFloat(req.query.bandwidthKbps as string)
    const f = req.query.format
    const asked: MusicFormat | null = f === 'aac' || f === 'alac' || f === 'original' ? f : null
    const format =
      asked ?? chooseFormat(file, accepts, isRemote(req) && Number.isFinite(kbps) ? kbps : null)
    return { format, track }
  }
  app.get('/api/music/tracks/:id/play', (req, res) => {
    const d = decide(req)
    if (!d) {
      res.status(404).json({ error: 'No such track' })
      return
    }
    const query = new URLSearchParams(req.query as Record<string, string>)
    query.set('format', d.format)
    res.json({
      format: d.format,
      lossless: d.format === 'alac' || (d.format === 'original' && d.track.lossless),
      path: `/api/music/tracks/${d.track.id}/stream?${query.toString()}`
    })
  })
  app.get('/api/music/tracks/:id/stream', async (req, res) => {
    const d = decide(req)
    const file = trackFile(id(req))
    if (!d || !file || !existsSync(file.path)) {
      res.status(404).end()
      return
    }
    const path =
      d.format === 'original' ? file.path : d.format === 'alac' ? await alacCopy(d.track.id) : await aacCopy(d.track.id)
    if (!path) {
      res.status(500).json({ error: "Couldn't convert this track" })
      return
    }
    res.sendFile(path, { headers: { 'Cache-Control': 'private, max-age=3600' } })
  })
}
