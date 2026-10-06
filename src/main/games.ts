import { app } from 'electron'
import { spawn } from 'child_process'
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'fs'
import { basename, dirname, extname, join, relative, resolve } from 'path'
import { crc32 } from 'zlib'
import express from 'express'
import type { Express, Request, Response } from 'express'
import ffmpegStatic from 'ffmpeg-static'
import { db } from './db'
import { emulatorDir, emulatorStatus, installEmulators } from './emulators'
import { fingerprint, identifyingFile } from './gameFingerprint'
import { cueFiles, gameName, m3uFiles, systemInfo, systemOf, thumbnailName } from './gamesCore'
import { sortKey } from './musicCore'
import playerHtml from './gamePlayer.html?raw'
import type { Game, GameDetail, GameSaveInfo, GameSystem, Library, ScanProgress } from '../shared/types'

// Retro games (Phase 7). The server keeps the games, their box art and
// everyone's saves; the games themselves run on each player's device, in
// EmulatorJS (emulators.ts), from the page in gamePlayer.html.
// MartBox ships no games: people add backups of games they own.

const ffmpegPath = (ffmpegStatic as string).replace('app.asar', 'app.asar.unpacked')

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL UNIQUE,
    system TEXT NOT NULL,
    title TEXT NOT NULL,
    sort_title TEXT NOT NULL,
    region TEXT,
    parts TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    cover_path TEXT,
    signature TEXT NOT NULL,
    fingerprint TEXT,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS game_saves (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('save', 'state')),
    slot INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL,
    has_screenshot INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (profile_id, game_id, kind, slot)
  );
`)

// 0.19.0 had no fingerprints (gameFingerprint.ts).
if (!(db.prepare('PRAGMA table_info(games)').all() as { name: string }[]).some((c) => c.name === 'fingerprint')) {
  db.exec('ALTER TABLE games ADD COLUMN fingerprint TEXT')
}

function userDir(...parts: string[]): string {
  const d = join(app.getPath('userData'), ...parts)
  mkdirSync(d, { recursive: true })
  return d
}

// --- Box art: a picture next to the game, else the libretro thumbnails

const IMAGES = ['.png', '.jpg', '.jpeg', '.webp']

function localArt(file: string): string | null {
  const stem = basename(file, extname(file))
  const dir = dirname(file)
  for (const folder of [dir, join(dir, 'boxart'), join(dir, 'covers'), join(dir, 'images')]) {
    for (const e of IMAGES) {
      const p = join(folder, stem + e)
      if (existsSync(p)) return p
    }
  }
  return null
}

async function fetchArt(system: GameSystem, file: string): Promise<Buffer | null> {
  const info = systemInfo(system)
  if (!info) return null
  const url = `https://thumbnails.libretro.com/${encodeURIComponent(info.thumbnails)}/Named_Boxarts/${encodeURIComponent(thumbnailName(file))}.png`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

async function saveCover(gameId: number, image: Buffer | string): Promise<void> {
  let source = typeof image === 'string' ? image : ''
  if (typeof image !== 'string') {
    source = join(userDir('game-covers'), `${gameId}.download`)
    writeFileSync(source, image)
  }
  const out = join(userDir('game-covers'), `${gameId}.jpg`)
  const tmp = `${out}.tmp.jpg`
  const ok = await new Promise<boolean>((done) => {
    const p = spawn(ffmpegPath, ['-v', 'error', '-y', '-i', source, '-frames:v', '1', '-vf', 'scale=600:600:force_original_aspect_ratio=decrease', '-q:v', '3', tmp])
    p.on('error', () => done(false))
    p.on('close', (code) => done(code === 0 && existsSync(tmp)))
  })
  if (typeof image !== 'string') rmSync(source, { force: true })
  if (!ok) return
  renameSync(tmp, out)
  db.prepare('UPDATE games SET cover_path = ? WHERE id = ?').run(out, gameId)
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
    else if (e.isFile()) out.push(p)
  }
}

interface Found {
  file: string
  system: GameSystem
  // A disc game's other files (tracks, discs), relative to its folder.
  parts: string[]
}

// The games in a library: disc tracks a .cue uses and discs a playlist
// lists belong to that game, not games of their own.
function findGames(root: string): Found[] {
  const files: string[] = []
  walk(root, files)
  const games: Found[] = []
  const owned = new Set<string>()
  const read = (f: string): string => {
    try {
      return readFileSync(f, 'utf8')
    } catch {
      return ''
    }
  }
  // Playlists first, then cue sheets, so a playlist's discs fold into it.
  const order = (f: string): number => ({ '.m3u': 0, '.cue': 1 })[extname(f).toLowerCase()] ?? 2
  for (const file of [...files].sort((a, b) => order(a) - order(b))) {
    if (owned.has(file)) continue
    const system = systemOf(file, root)
    if (!system) continue
    const e = extname(file).toLowerCase()
    let parts: string[] = []
    if (e === '.m3u') {
      for (const disc of m3uFiles(read(file))) {
        const discPath = resolve(dirname(file), disc)
        parts.push(disc)
        owned.add(discPath)
        if (extname(disc).toLowerCase() === '.cue') {
          for (const t of cueFiles(read(discPath))) {
            parts.push(join(dirname(disc), t))
            owned.add(resolve(dirname(discPath), t))
          }
        }
      }
    } else if (e === '.cue') {
      parts = cueFiles(read(file))
      parts.forEach((t) => owned.add(resolve(dirname(file), t)))
    }
    // Every part has to be there and stay inside the game's folder.
    if (parts.some((p) => p.startsWith('..') || !existsSync(join(dirname(file), p)))) continue
    games.push({ file, system, parts })
  }
  return games.filter((g) => !owned.has(g.file))
}

function gameSize(g: Found): number {
  return [g.file, ...g.parts.map((p) => join(dirname(g.file), p))].reduce((sum, f) => sum + (statSync(f, { throwIfNoEntry: false })?.size ?? 0), 0)
}

export async function scanGameLibrary(library: Library, onProgress: (p: ScanProgress) => void): Promise<void> {
  // The first games library fetches the emulators in the background.
  void installEmulators().catch(() => undefined)
  onProgress({ libraryId: library.id, phase: 'scanning', current: 0, total: 0, message: 'Finding games…' })
  const known = new Map(
    (db.prepare('SELECT id, file_path, signature, cover_path, fingerprint FROM games WHERE library_id = ?').all(library.id) as KnownGame[]).map((r) => [r.file_path, r])
  )
  // A folder that can't be reached (a drive unplugged or asleep) is left as
  // it was: scanning it would forget every game, and everyone's saves with them.
  let reachable = false
  try {
    reachable = statSync(library.path).isDirectory()
  } catch {
    /* not there */
  }
  const found = reachable ? findGames(library.path) : []
  if (!reachable || (found.length === 0 && known.size > 0)) {
    onProgress({ libraryId: library.id, phase: 'done', current: 1, total: 1, message: 'Done' })
    // Shown under the library in Settings.
    throw new Error(
      reachable
        ? 'No games were found in this folder, so the library was left as it was. If you removed them all on purpose, remove the library instead.'
        : "Couldn't reach this folder (is the drive connected?), so the library was left as it was."
    )
  }
  const present = new Set(found.map((g) => g.file))
  // Games no longer where they were, by fingerprint: a "new" file with the
  // same one is that game renamed or moved, and keeps its saves.
  const missing = new Map<string, number>()
  for (const r of db.prepare('SELECT id, library_id, file_path, fingerprint FROM games WHERE fingerprint IS NOT NULL').all() as {
    id: number
    library_id: number
    file_path: string
    fingerprint: string
  }[]) {
    const gone = r.library_id === library.id ? !present.has(r.file_path) : !existsSync(r.file_path)
    if (gone) missing.set(r.fingerprint, r.id)
  }
  let done = 0
  for (const g of found) {
    const size = gameSize(g)
    const st = statSync(g.file)
    const signature = `${size}|${Math.round(st.mtimeMs)}|${g.parts.length}`
    let before = known.get(g.file)
    let print = before?.fingerprint ?? null
    if (!before || !print) print = fingerprint(identifyingFile(g.file, g.parts, (p) => join(dirname(g.file), p)))
    const movedId = !before && print ? missing.get(print) : undefined
    if (movedId !== undefined && print) {
      const old = db.prepare('SELECT * FROM games WHERE id = ?').get(movedId) as KnownGame
      db.prepare('UPDATE games SET file_path = ?, library_id = ? WHERE id = ?').run(g.file, library.id, movedId)
      // Its packed disc names the old files.
      rmSync(join(userDir('game-cache'), `${movedId}.zip`), { force: true })
      missing.delete(print)
      before = { ...old, file_path: g.file, signature: '' }
    }
    if (before?.signature !== signature) {
      const name = gameName(g.file)
      const values = [library.id, g.system, name.title, sortKey(name.title), name.region, g.parts.length ? JSON.stringify(g.parts) : null, size, signature, print]
      if (before) {
        db.prepare(
          'UPDATE games SET library_id = ?, system = ?, title = ?, sort_title = ?, region = ?, parts = ?, size = ?, signature = ?, fingerprint = ? WHERE file_path = ?'
        ).run(...values, g.file)
        rmSync(packedPath(g.file), { force: true })
      } else {
        db.prepare(
          'INSERT INTO games (library_id, system, title, sort_title, region, parts, size, signature, fingerprint, file_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(...values, g.file)
      }
    } else if (!before.fingerprint && print) {
      // Games scanned before fingerprints existed get theirs now.
      db.prepare('UPDATE games SET fingerprint = ? WHERE id = ?').run(print, before.id)
    }
    if (!before?.cover_path || !existsSync(before.cover_path)) {
      const { id } = db.prepare('SELECT id FROM games WHERE file_path = ?').get(g.file) as { id: number }
      const art = localArt(g.file) ?? (await fetchArt(g.system, g.file))
      if (art) await saveCover(id, art)
    }
    done++
    onProgress({ libraryId: library.id, phase: 'matching', current: done, total: found.length, message: basename(g.file) })
  }
  const remove = db.prepare('DELETE FROM games WHERE file_path = ?')
  db.transaction(() => [...known.keys()].filter((p) => !present.has(p)).forEach((p) => remove.run(p)))()
  onProgress({ libraryId: library.id, phase: 'done', current: 1, total: 1, message: 'Done' })
}

interface KnownGame {
  id: number
  file_path: string
  signature: string
  cover_path: string | null
  fingerprint: string | null
}

// --- Disc games travel as one ZIP (stored, not compressed: discs don't shrink)

function packedPath(file: string): string {
  const row = db.prepare('SELECT id FROM games WHERE file_path = ?').get(file) as { id: number } | undefined
  return join(userDir('game-cache'), `${row?.id ?? 'none'}.zip`)
}

async function fileCrc(path: string): Promise<number> {
  let crc = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) crc = crc32(chunk as Buffer, crc)
  return crc
}

// A ZIP64 writer for a handful of large files, stored as they are.
async function packZip(out: string, entries: { name: string; path: string }[]): Promise<void> {
  const tmp = `${out}.part`
  const fd = openSync(tmp, 'w')
  let offset = 0
  const central: Buffer[] = []
  const write = (b: Buffer): void => {
    writeSync(fd, b)
    offset += b.length
  }
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name.split(/[\\/]/).join('/'), 'utf8')
      const size = statSync(e.path).size
      const crc = await fileCrc(e.path)
      const start = offset
      const zip64 = Buffer.alloc(20)
      zip64.writeUInt16LE(0x0001, 0)
      zip64.writeUInt16LE(16, 2)
      zip64.writeBigUInt64LE(BigInt(size), 4)
      zip64.writeBigUInt64LE(BigInt(size), 12)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(45, 4)
      local.writeUInt16LE(0x0800, 6)
      local.writeUInt32LE(crc >>> 0, 14)
      local.writeUInt32LE(0xffffffff, 18)
      local.writeUInt32LE(0xffffffff, 22)
      local.writeUInt16LE(name.length, 26)
      local.writeUInt16LE(zip64.length, 28)
      write(Buffer.concat([local, name, zip64]))
      for await (const chunk of createReadStream(e.path, { highWaterMark: 1 << 20 })) write(chunk as Buffer)
      const extra = Buffer.alloc(28)
      extra.writeUInt16LE(0x0001, 0)
      extra.writeUInt16LE(24, 2)
      extra.writeBigUInt64LE(BigInt(size), 4)
      extra.writeBigUInt64LE(BigInt(size), 12)
      extra.writeBigUInt64LE(BigInt(start), 20)
      const head = Buffer.alloc(46)
      head.writeUInt32LE(0x02014b50, 0)
      head.writeUInt16LE(45, 4)
      head.writeUInt16LE(45, 6)
      head.writeUInt16LE(0x0800, 8)
      head.writeUInt32LE(crc >>> 0, 16)
      head.writeUInt32LE(0xffffffff, 20)
      head.writeUInt32LE(0xffffffff, 24)
      head.writeUInt16LE(name.length, 28)
      head.writeUInt16LE(extra.length, 30)
      head.writeUInt32LE(0xffffffff, 42)
      central.push(Buffer.concat([head, name, extra]))
    }
    const cdStart = offset
    const cd = Buffer.concat(central)
    write(cd)
    const eocd64 = Buffer.alloc(56)
    eocd64.writeUInt32LE(0x06064b50, 0)
    eocd64.writeBigUInt64LE(44n, 4)
    eocd64.writeUInt16LE(45, 12)
    eocd64.writeUInt16LE(45, 14)
    eocd64.writeBigUInt64LE(BigInt(entries.length), 24)
    eocd64.writeBigUInt64LE(BigInt(entries.length), 32)
    eocd64.writeBigUInt64LE(BigInt(cd.length), 40)
    eocd64.writeBigUInt64LE(BigInt(cdStart), 48)
    const eocd64Start = offset
    write(eocd64)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeBigUInt64LE(BigInt(eocd64Start), 8)
    locator.writeUInt32LE(1, 16)
    write(locator)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0xffff, 8)
    eocd.writeUInt16LE(0xffff, 10)
    eocd.writeUInt32LE(0xffffffff, 12)
    eocd.writeUInt32LE(0xffffffff, 16)
    write(eocd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, out)
}

const packing = new Map<number, Promise<string>>()

// Packed discs are kept for the next play, up to this much in all; the
// least recently played go first.
const GAME_CACHE_LIMIT = 8 * 1024 * 1024 * 1024

function trimGameCache(keep: string): void {
  const dir = userDir('game-cache')
  const files = readdirSync(dir)
    .filter((n) => n.endsWith('.zip'))
    .map((n) => join(dir, n))
    .map((p) => ({ path: p, ...statSync(p) }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
  let total = files.reduce((sum, f) => sum + f.size, 0)
  for (const f of files) {
    if (total <= GAME_CACHE_LIMIT) break
    if (f.path === keep) continue
    try {
      rmSync(f.path, { force: true })
      total -= f.size
    } catch {
      /* still being sent (Windows keeps open files): next time */
    }
  }
}

function packedGame(r: any): Promise<string> {
  const out = packedPath(r.file_path)
  if (existsSync(out)) {
    const now = new Date()
    utimesSync(out, now, now)
    return Promise.resolve(out)
  }
  const running = packing.get(r.id)
  if (running) return running
  const parts: string[] = JSON.parse(r.parts)
  const job = packZip(out, [
    { name: basename(r.file_path), path: r.file_path },
    ...parts.map((p) => ({ name: p, path: join(dirname(r.file_path), p) }))
  ])
    .then(() => {
      trimGameCache(out)
      return out
    })
    .finally(() => packing.delete(r.id))
  packing.set(r.id, job)
  return job
}

// --- Saves: files under userData/game-saves/<profile>/<game>/

const MAX_SLOT = 9

function savePath(profileId: number, gameId: number, kind: 'save' | 'state', slot: number, screenshot = false): string {
  const dir = userDir('game-saves', String(profileId), String(gameId))
  return join(dir, kind === 'save' ? 'save.bin' : `state-${slot}.${screenshot ? 'png' : 'bin'}`)
}

function toSave(r: any): GameSaveInfo {
  return { gameId: r.game_id, kind: r.kind, slot: r.slot, size: r.size, hasScreenshot: !!r.has_screenshot, updatedAt: r.updated_at }
}

export function listSaves(profileId: number, gameId?: number): GameSaveInfo[] {
  const rows = gameId
    ? db.prepare('SELECT * FROM game_saves WHERE profile_id = ? AND game_id = ? ORDER BY kind, slot').all(profileId, gameId)
    : db.prepare('SELECT * FROM game_saves WHERE profile_id = ? ORDER BY updated_at DESC').all(profileId)
  return (rows as any[]).map(toSave)
}

// --- Reading

function toGame(r: any): Game {
  return { id: r.id, system: r.system, title: r.title, region: r.region ?? null, size: r.size, hasCover: !!r.cover_path, addedAt: r.added_at }
}

export function listGames(): Game[] {
  return (db.prepare('SELECT * FROM games ORDER BY sort_title, region').all() as any[]).map(toGame)
}

// --- HTTP

type CanAct = (res: Response, profileId: number, pin: string | undefined) => boolean

export function registerGameRoutes(app: Express, canActAsProfile: CanAct): void {
  const raw = express.raw({ type: () => true, limit: '64mb' })
  const id = (req: Request): number => parseInt(req.params.id, 10)
  const row = (req: Request): any => db.prepare('SELECT * FROM games WHERE id = ?').get(id(req))
  const slotOf = (req: Request): number | null => {
    const n = parseInt(req.params.slot, 10)
    return Number.isInteger(n) && n >= 0 && n <= MAX_SLOT ? n : null
  }
  // The profile a save belongs to, from ?profileId (and ?pin).
  const profileOf = (req: Request, res: Response): number | null => {
    const profileId = parseInt(String(req.query.profileId), 10)
    if (!Number.isInteger(profileId) || !canActAsProfile(res, profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return null
    }
    return profileId
  }

  app.get('/api/games', (_req, res) => res.json(listGames()))

  app.get('/api/games/emulators', (_req, res) => res.json(emulatorStatus()))

  // Before /:id, which would take "saves" as an id.
  app.get('/api/games/saves', (req, res) => {
    const profileId = profileOf(req, res)
    if (profileId !== null) res.json(listSaves(profileId))
  })

  app.get('/api/games/:id', (req, res) => {
    const r = row(req)
    if (!r) {
      res.status(404).json({ error: 'No such game' })
      return
    }
    const profileId = parseInt(String(req.query.profileId), 10)
    const saves = Number.isInteger(profileId) && canActAsProfile(res, profileId, req.query.pin as string | undefined) ? listSaves(profileId, r.id) : []
    const fileName = r.parts ? `${basename(r.file_path, extname(r.file_path))}.zip` : basename(r.file_path)
    res.json({ ...toGame(r), core: systemInfo(r.system)?.core ?? '', fileName, saves } satisfies GameDetail)
  })

  app.get('/api/games/:id/cover', (req, res) => {
    const r = row(req)
    if (!r?.cover_path || !existsSync(r.cover_path)) {
      res.status(404).end()
      return
    }
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.sendFile(r.cover_path)
  })

  // The game itself, for the emulator on the device. The name on the end
  // is the file's, so the emulator sees its extension.
  app.get('/api/games/:id/file/:name', async (req, res) => {
    const r = row(req)
    if (!r || !existsSync(r.file_path)) {
      res.status(404).end()
      return
    }
    // Checked each time (a quick 304 when unchanged), so a replaced file is picked up.
    const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-cache' }
    if (!r.parts) {
      res.sendFile(r.file_path, { headers })
      return
    }
    try {
      res.sendFile(await packedGame(r), { headers: { ...headers, 'Content-Type': 'application/zip' } })
    } catch {
      res.status(500).json({ error: "Couldn't prepare this game" })
    }
  })

  // The game's own save (battery save / memory card), raw bytes.
  app.get('/api/games/:id/save', (req, res) => {
    const profileId = profileOf(req, res)
    if (profileId === null) return
    const p = savePath(profileId, id(req), 'save', 0)
    if (existsSync(p)) res.sendFile(p, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } })
    else res.status(404).end()
  })

  // Save states by slot (0: the automatic one), plus each one's screenshot.
  app.get('/api/games/:id/states/:slot', (req, res) => {
    const profileId = profileOf(req, res)
    const slot = slotOf(req)
    if (profileId === null) return
    const p = slot === null ? null : savePath(profileId, id(req), 'state', slot)
    if (p && existsSync(p)) res.sendFile(p, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } })
    else res.status(404).end()
  })

  app.get('/api/games/:id/states/:slot/screenshot', (req, res) => {
    const profileId = profileOf(req, res)
    const slot = slotOf(req)
    if (profileId === null) return
    const p = slot === null ? null : savePath(profileId, id(req), 'state', slot, true)
    if (p && existsSync(p)) res.sendFile(p, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } })
    else res.status(404).end()
  })

  const store = (kind: 'save' | 'state', screenshot = false) => (req: Request, res: Response): void => {
    const profileId = profileOf(req, res)
    if (profileId === null) return
    const slot = kind === 'save' ? 0 : slotOf(req)
    const gameId = id(req)
    if (slot === null || !db.prepare('SELECT 1 FROM games WHERE id = ?').get(gameId)) {
      res.status(404).json({ error: 'No such game or slot' })
      return
    }
    const body = req.body as Buffer
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'Send the save as the request body' })
      return
    }
    if (screenshot && !db.prepare("SELECT 1 FROM game_saves WHERE profile_id = ? AND game_id = ? AND kind = 'state' AND slot = ?").get(profileId, gameId, slot)) {
      res.status(404).json({ error: 'Save the state first' })
      return
    }
    const p = savePath(profileId, gameId, kind, slot, screenshot)
    writeFileSync(`${p}.part`, body)
    renameSync(`${p}.part`, p)
    if (screenshot) {
      db.prepare("UPDATE game_saves SET has_screenshot = 1 WHERE profile_id = ? AND game_id = ? AND kind = 'state' AND slot = ?").run(profileId, gameId, slot)
    } else {
      // A new state's old screenshot no longer matches it.
      if (kind === 'state') rmSync(savePath(profileId, gameId, 'state', slot, true), { force: true })
      db.prepare(
        `INSERT INTO game_saves (profile_id, game_id, kind, slot, size, has_screenshot, updated_at) VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
         ON CONFLICT (profile_id, game_id, kind, slot) DO UPDATE SET size = excluded.size, has_screenshot = 0, updated_at = excluded.updated_at`
      ).run(profileId, gameId, kind, slot, body.length)
    }
    res.json({ ok: true })
  }
  app.put('/api/games/:id/save', raw, store('save'))
  app.put('/api/games/:id/states/:slot', raw, store('state'))
  app.put('/api/games/:id/states/:slot/screenshot', raw, store('state', true))

  // The player page and the emulators the server downloaded.
  app.get('/emulator/player.html', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache')
    res.type('html').send(playerHtml)
  })
  app.use('/emulator', (req, res, next) => {
    const dir = emulatorDir()
    if (emulatorStatus().state !== 'ready') {
      res.status(503).json({ error: 'The emulators are still downloading' })
      return
    }
    const file = resolve(dir, '.' + decodeURIComponent(req.path))
    if (relative(dir, file).startsWith('..') || !existsSync(file) || !statSync(file).isFile()) {
      next()
      return
    }
    res.sendFile(file, { headers: { 'Cache-Control': 'public, max-age=604800' } })
  })
}
