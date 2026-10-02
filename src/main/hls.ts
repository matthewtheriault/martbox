import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import type express from 'express'

// HLS for files that can't be played as-is. Apple's players (AVPlayer on
// iPhone, iPad and Apple TV) refuse a progressive stream that can't serve
// byte ranges — the on-the-fly fragmented MP4 that /stream pipes out works
// in the desktop app's <video> but fails there with -12939. HLS is what
// they're built for: ffmpeg writes 4-second segments plus a playlist into a
// per-session folder, and the client reads them like any other file.
//
// A session belongs to one viewer (device / local window), one file and
// one start position. Skipping to a new position starts a new session and
// ends that viewer's previous one for the same file; idle sessions are
// stopped and their folders deleted.

const SEGMENT_SECONDS = 4
// Long enough that a paused movie can be resumed (the transcode usually
// finishes well ahead, after which the player stops polling the playlist).
const IDLE_MS = 20 * 60 * 1000
const MAX_SESSIONS = 6
const PLAYLIST_WAIT_MS = 30_000
const SEGMENT_WAIT_MS = 30_000
const SEGMENT_NAME = /^seg\d{5}\.ts$/

export interface HlsDeps {
  ffmpegPath: string
  resolveMediaPath(mediaType: string, id: number): string | null
  // ffmpeg video arguments for this file: '-c:v copy' when the source is
  // already H.264, otherwise an encoder (hardware when available) capped to
  // 1080p and a bitrate a remote connection can carry.
  videoArgs(filePath: string): Promise<{ args: string[]; copy: boolean }>
  // Who's asking — a device id, or 'local' / 'legacy'. Sessions are only
  // served back to their owner.
  ownerOf(res: express.Response): string
  // Folder the segment folders go in (Settings can point this at a data
  // drive instead of the system drive).
  cacheDir(): string
  log(message: string): void
}

interface Session {
  id: string
  owner: string
  mediaKey: string
  start: number
  dir: string
  proc: ChildProcess
  exited: boolean
  lastAccess: number
}

const sessions = new Map<string, Session>()

function stopSession(session: Session): void {
  sessions.delete(session.id)
  if (!session.exited) session.proc.kill('SIGKILL')
  // ffmpeg may still hold the last segment open for a moment after kill.
  setTimeout(() => rmSync(session.dir, { recursive: true, force: true }), 2000)
}

export function stopAllHlsSessions(): void {
  for (const session of [...sessions.values()]) stopSession(session)
}

function playlistPath(session: Session): string {
  return join(session.dir, 'index.m3u8')
}

function readPlaylist(session: Session): string | null {
  const path = playlistPath(session)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// ffmpeg rewrites the playlist only after a segment is fully written, so a
// segment listed there is complete.
function listedSegments(playlist: string): string[] {
  return playlist.split('\n').filter((l) => SEGMENT_NAME.test(l.trim())).map((l) => l.trim())
}

async function waitFor<T>(check: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value !== null) return value
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function startSession(
  deps: HlsDeps,
  owner: string,
  mediaKey: string,
  filePath: string,
  start: number
): Promise<Session> {
  // A new position for the same file replaces this viewer's old session.
  for (const s of [...sessions.values()]) {
    if (s.owner === owner && s.mediaKey === mediaKey) stopSession(s)
  }
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastAccess - b.lastAccess)[0]
    stopSession(oldest)
  }

  const id = randomUUID()
  const dir = join(deps.cacheDir(), id)
  mkdirSync(dir, { recursive: true })
  const { args: videoArgs, copy } = await deps.videoArgs(filePath)
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(start),
    '-i',
    filePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    ...videoArgs,
    // Segment boundaries need a keyframe; when re-encoding, put one exactly
    // every segment so they line up.
    ...(copy ? [] : ['-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`]),
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-b:a',
    '192k',
    '-avoid_negative_ts',
    'make_zero',
    '-f',
    'hls',
    '-hls_time',
    String(SEGMENT_SECONDS),
    '-hls_playlist_type',
    'event',
    '-hls_list_size',
    '0',
    '-hls_segment_filename',
    join(dir, 'seg%05d.ts'),
    join(dir, 'index.m3u8')
  ]
  deps.log(`HLS START session=${id} file=${filePath} start=${start} args=${JSON.stringify(args)}`)
  const proc = spawn(deps.ffmpegPath, args)
  const session: Session = { id, owner, mediaKey, start, dir, proc, exited: false, lastAccess: Date.now() }
  let stderrTail = ''
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-8000)
  })
  proc.on('error', (err) => {
    session.exited = true
    deps.log(`HLS SPAWN ERROR session=${id} error=${err.message}`)
  })
  proc.on('exit', (code, signal) => {
    session.exited = true
    deps.log(`HLS EXIT session=${id} code=${code} signal=${signal}${stderrTail ? `\n${stderrTail}` : ''}`)
  })
  sessions.set(id, session)
  return session
}

const SESSION_DIR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Session folders left behind by a crash or a forced quit. Only our own
// (UUID-named) folders are touched, so pointing the cache at an existing
// folder never deletes anything else in it.
export function clearStaleHlsFolders(dir: string): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (SESSION_DIR_NAME.test(name) && ![...sessions.values()].some((s) => s.id === name)) {
      rmSync(join(dir, name), { recursive: true, force: true })
    }
  }
}

export function registerHlsRoutes(app: express.Express, deps: HlsDeps): void {
  clearStaleHlsFolders(deps.cacheDir())
  setInterval(() => {
    const now = Date.now()
    for (const s of [...sessions.values()]) {
      if (now - s.lastAccess > IDLE_MS) stopSession(s)
    }
  }, 60_000).unref()

  // The playlist. The player re-requests this URL while the transcode is
  // still running (an EVENT playlist grows); the same viewer, file and
  // start position always get the same session back.
  app.get('/hls/:mediaType/:id/index.m3u8', async (req, res) => {
    const { mediaType } = req.params
    const id = parseInt(req.params.id, 10)
    const filePath = deps.resolveMediaPath(mediaType, id)
    if (!filePath || !existsSync(filePath)) {
      res.status(404).end()
      return
    }
    const start = Math.max(0, Math.floor(Number(req.query.start) || 0))
    const owner = deps.ownerOf(res)
    const mediaKey = `${mediaType}:${id}`
    let session = [...sessions.values()].find(
      (s) => s.owner === owner && s.mediaKey === mediaKey && s.start === start
    )
    if (!session) session = await startSession(deps, owner, mediaKey, filePath, start)
    session.lastAccess = Date.now()

    const current = session
    const playlist = await waitFor(() => {
      const text = readPlaylist(current)
      if (text && (listedSegments(text).length > 0 || text.includes('#EXT-X-ENDLIST'))) return text
      if (current.exited) return ''
      return null
    }, PLAYLIST_WAIT_MS)
    if (!playlist) {
      res.status(playlist === '' ? 500 : 504).end()
      return
    }
    // Segment URLs are made absolute and carry the same signed media link
    // the playlist was fetched with — a player doesn't pass query strings
    // on to relative URLs.
    const mt = typeof req.query.mt === 'string' ? req.query.mt : null
    const suffix = mt ? `?mt=${encodeURIComponent(mt)}` : ''
    const body = playlist
      .split('\n')
      .map((line) =>
        SEGMENT_NAME.test(line.trim()) ? `/hls/session/${current.id}/${line.trim()}${suffix}` : line
      )
      .join('\n')
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(body)
  })

  app.get('/hls/session/:sid/:file', async (req, res) => {
    const session = sessions.get(req.params.sid)
    const file = req.params.file
    if (!session || session.owner !== deps.ownerOf(res) || !SEGMENT_NAME.test(file)) {
      res.status(404).end()
      return
    }
    session.lastAccess = Date.now()
    const ready = await waitFor(() => {
      const text = readPlaylist(session)
      if (text && listedSegments(text).includes(file)) return true
      if (session.exited) return false
      return null
    }, SEGMENT_WAIT_MS)
    if (!ready) {
      res.status(404).end()
      return
    }
    res.setHeader('Content-Type', 'video/mp2t')
    res.sendFile(join(session.dir, file))
  })
}
