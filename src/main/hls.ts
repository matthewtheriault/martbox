import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import type express from 'express'

// HLS for files that can't be played as-is. Apple's players (AVPlayer on
// iPhone, iPad and Apple TV) refuse a progressive stream that can't serve
// byte ranges — the on-the-fly fragmented MP4 that /stream pipes out works
// in the desktop app's <video> but fails there with -12939.
//
// The playlist is VOD: every 4-second segment of the whole file is listed
// up front with the real total length, so the player shows a normal
// timeline and can scrub anywhere (a growing EVENT playlist makes AVPlayer
// treat the video as a live broadcast). Segments are transcoded on demand
// by one ffmpeg "run" per session; a request far from what the current run
// is producing (the viewer scrubbed) restarts the run at that segment. Each
// run offsets its timestamps to the segment's absolute time and forces a
// keyframe every 4 s, so segments from different runs line up.

const SEGMENT_SECONDS = 4
// How far past the run's newest segment a request may be and still just
// wait for the run to get there, rather than restarting it.
const RUN_LOOKAHEAD_SEGMENTS = 6
// Keep at most this much already-played video on disk per session;
// anything older is deleted and simply re-transcoded if scrubbed back to.
const KEEP_BEHIND_SEGMENTS = (30 * 60) / SEGMENT_SECONDS
// A paused video keeps its session this long.
const IDLE_MS = 20 * 60 * 1000
const MAX_SESSIONS = 6
const SEGMENT_WAIT_MS = 30_000
const SEGMENT_NAME = /^seg(\d{5})\.ts$/

export interface HlsDeps {
  ffmpegPath: string
  resolveMediaPath(mediaType: string, id: number): string | null
  durationSeconds(filePath: string): Promise<number | null>
  // ffmpeg video encoder arguments (hardware when available), capped to
  // 1080p and a bitrate a remote connection can carry.
  videoArgs(): Promise<string[]>
  // Who's asking — a device id, or 'local' / 'legacy'. Sessions are only
  // served back to their owner.
  ownerOf(res: express.Response): string
  // Folder the session folders go in (Settings can point this at a data
  // drive instead of the system drive).
  cacheDir(): string
  log(message: string): void
}

interface Run {
  proc: ChildProcess
  startSegment: number
  playlist: string
  exited: boolean
}

interface Session {
  id: string
  owner: string
  mediaKey: string
  filePath: string
  segmentCount: number
  durationSeconds: number
  dir: string
  run: Run | null
  completed: Set<number>
  lastAccess: number
}

const sessions = new Map<string, Session>()

function killRun(session: Session): void {
  if (session.run && !session.run.exited) session.run.proc.kill('SIGKILL')
  session.run = null
}

function stopSession(session: Session): void {
  sessions.delete(session.id)
  killRun(session)
  // ffmpeg may still hold the last segment open for a moment after kill.
  setTimeout(() => rmSync(session.dir, { recursive: true, force: true }), 2000)
}

export function stopAllHlsSessions(): void {
  for (const session of [...sessions.values()]) stopSession(session)
}

const SESSION_DIR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Session folders left behind by a crash or a forced quit. Only our own
// (UUID-named) folders are touched, so pointing the cache at an existing
// folder never deletes anything else in it.
export function clearStaleHlsFolders(dir: string): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (SESSION_DIR_NAME.test(name) && !sessions.has(name)) {
      rmSync(join(dir, name), { recursive: true, force: true })
    }
  }
}

// Segments are SEGMENT_SECONDS long except the last. A leftover of under a
// second is folded into the last segment rather than listed on its own:
// ffmpeg only starts a segment at a forced keyframe, and a keyframe that
// late usually has no frame left to land on, so such a tiny segment would
// never be written and the player would stall at the very end.
export function segmentCount(durationSeconds: number): number {
  return Math.max(1, Math.ceil(durationSeconds / SEGMENT_SECONDS - 0.25))
}

// Builds the full VOD playlist.
export function vodPlaylist(
  durationSeconds: number,
  segmentUrl: (index: number) => string
): string {
  const count = segmentCount(durationSeconds)
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    // Must cover the longest segment — the last can run to SEGMENT_SECONDS + 1.
    `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS + 1}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD'
  ]
  for (let i = 0; i < count; i++) {
    const length = i < count - 1 ? SEGMENT_SECONDS : durationSeconds - SEGMENT_SECONDS * (count - 1)
    lines.push(`#EXTINF:${Math.max(0.001, length).toFixed(3)},`, segmentUrl(i))
  }
  lines.push('#EXT-X-ENDLIST', '')
  return lines.join('\n')
}

function segmentName(index: number): string {
  return `seg${String(index).padStart(5, '0')}.ts`
}

// ffmpeg rewrites its own playlist only after a segment is fully written,
// so a segment listed there is complete.
function refreshCompleted(session: Session): void {
  const run = session.run
  if (!run) return
  const path = join(session.dir, run.playlist)
  if (!existsSync(path)) return
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    const m = SEGMENT_NAME.exec(line.trim())
    if (m) session.completed.add(parseInt(m[1], 10))
  }
}

function runHead(session: Session): number {
  const run = session.run
  if (!run) return -1
  let head = run.startSegment - 1
  while (session.completed.has(head + 1)) head++
  return head
}

async function startRun(deps: HlsDeps, session: Session, startSegment: number): Promise<void> {
  killRun(session)
  const startSeconds = startSegment * SEGMENT_SECONDS
  const playlist = `run-${startSegment}-${Date.now()}.m3u8`
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(startSeconds),
    '-i',
    session.filePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    ...(await deps.videoArgs()),
    // A keyframe exactly every segment, counted from this run's start —
    // which is itself on a segment boundary — so every run cuts at the
    // same absolute times.
    '-force_key_frames',
    `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-b:a',
    '192k',
    // Timestamps continue from the segment's place in the whole file.
    '-output_ts_offset',
    String(startSeconds),
    '-muxdelay',
    '0',
    '-f',
    'hls',
    '-hls_time',
    String(SEGMENT_SECONDS),
    '-hls_playlist_type',
    'event',
    '-hls_list_size',
    '0',
    '-start_number',
    String(startSegment),
    '-hls_segment_filename',
    join(session.dir, 'seg%05d.ts'),
    join(session.dir, playlist)
  ]
  deps.log(`HLS RUN session=${session.id} start=${startSeconds}s args=${JSON.stringify(args)}`)
  const proc = spawn(deps.ffmpegPath, args)
  const run: Run = { proc, startSegment, playlist, exited: false }
  let stderrTail = ''
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-8000)
  })
  proc.on('error', (err) => {
    run.exited = true
    deps.log(`HLS SPAWN ERROR session=${session.id} error=${err.message}`)
  })
  proc.on('exit', (code, signal) => {
    run.exited = true
    deps.log(
      `HLS RUN EXIT session=${session.id} start=${startSeconds}s code=${code} signal=${signal}${stderrTail ? `\n${stderrTail}` : ''}`
    )
  })
  session.run = run
}

// Deletes segments well behind the one being watched; they're re-made if
// the viewer scrubs back.
function pruneBehind(session: Session, index: number): void {
  for (const done of [...session.completed]) {
    if (done < index - KEEP_BEHIND_SEGMENTS) {
      session.completed.delete(done)
      rmSync(join(session.dir, segmentName(done)), { force: true })
    }
  }
}

async function ensureSegment(deps: HlsDeps, session: Session, index: number): Promise<boolean> {
  refreshCompleted(session)
  if (session.completed.has(index)) return true
  const run = session.run
  const head = runHead(session)
  const runCovers =
    run !== null && !run.exited && index >= run.startSegment && index <= head + RUN_LOOKAHEAD_SEGMENTS
  if (!runCovers) await startRun(deps, session, index)

  const deadline = Date.now() + SEGMENT_WAIT_MS
  while (Date.now() < deadline) {
    refreshCompleted(session)
    if (session.completed.has(index)) return true
    if (!session.run || session.run.exited) {
      refreshCompleted(session)
      return session.completed.has(index)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

export function registerHlsRoutes(app: express.Express, deps: HlsDeps): void {
  clearStaleHlsFolders(deps.cacheDir())
  setInterval(() => {
    const now = Date.now()
    for (const s of [...sessions.values()]) {
      if (now - s.lastAccess > IDLE_MS) stopSession(s)
    }
  }, 60_000).unref()

  // The playlist: one session per viewer and file, reused across requests.
  app.get('/hls/:mediaType/:id/index.m3u8', async (req, res) => {
    const { mediaType } = req.params
    const id = parseInt(req.params.id, 10)
    const filePath = deps.resolveMediaPath(mediaType, id)
    if (!filePath || !existsSync(filePath)) {
      res.status(404).end()
      return
    }
    const owner = deps.ownerOf(res)
    const mediaKey = `${mediaType}:${id}`
    let session = [...sessions.values()].find((s) => s.owner === owner && s.mediaKey === mediaKey)
    if (!session) {
      const duration = await deps.durationSeconds(filePath)
      if (!duration || !Number.isFinite(duration) || duration <= 0) {
        res.status(415).json({ error: "Can't read this file's length, so it can't be streamed." })
        return
      }
      while (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.values()].sort((a, b) => a.lastAccess - b.lastAccess)[0]
        stopSession(oldest)
      }
      const sid = randomUUID()
      const dir = join(deps.cacheDir(), sid)
      mkdirSync(dir, { recursive: true })
      session = {
        id: sid,
        owner,
        mediaKey,
        filePath,
        durationSeconds: duration,
        segmentCount: segmentCount(duration),
        dir,
        run: null,
        completed: new Set(),
        lastAccess: Date.now()
      }
      sessions.set(sid, session)
    }
    session.lastAccess = Date.now()
    // Segment URLs are absolute and carry the same signed media link the
    // playlist was fetched with — a player doesn't pass query strings on to
    // relative URLs.
    const mt = typeof req.query.mt === 'string' ? req.query.mt : null
    const suffix = mt ? `?mt=${encodeURIComponent(mt)}` : ''
    const sid = session.id
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(vodPlaylist(session.durationSeconds, (i) => `/hls/session/${sid}/${segmentName(i)}${suffix}`))
  })

  app.get('/hls/session/:sid/:file', async (req, res) => {
    const session = sessions.get(req.params.sid)
    const m = SEGMENT_NAME.exec(req.params.file)
    if (!session || session.owner !== deps.ownerOf(res) || !m) {
      res.status(404).end()
      return
    }
    const index = parseInt(m[1], 10)
    if (index >= session.segmentCount) {
      res.status(404).end()
      return
    }
    session.lastAccess = Date.now()
    if (!(await ensureSegment(deps, session, index))) {
      res.status(503).end()
      return
    }
    pruneBehind(session, index)
    res.setHeader('Content-Type', 'video/mp2t')
    res.sendFile(join(session.dir, segmentName(index)))
  })
}
