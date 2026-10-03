import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import type express from 'express'
import type { MediaProbe } from './ffprobe'
import { TRANSCODE_LADDER, type TranscodeRung } from './playback'

// HLS for files Apple's players (AVPlayer on iPhone, iPad and Apple TV)
// can't open as they are. AVPlayer refuses a progressive stream that can't
// serve byte ranges — the on-the-fly fragmented MP4 that /stream pipes out
// works in the desktop app's <video> but fails there with -12939 — and it
// can't open MKV at all.
//
// Every playlist is VOD: every segment of the whole file is listed up front
// with the real total length, so the player shows a normal timeline and can
// scrub anywhere (a growing EVENT playlist makes AVPlayer treat the video
// as a live broadcast). Segments are made on demand by one ffmpeg "run" per
// session; a request far from what the current run is producing (the
// viewer scrubbed) restarts the run at that segment.
//
// Two kinds of session (see playback.ts for which is used when):
//
// transcode — re-encoded to H.264 at a chosen size. Each run forces a
//   keyframe every 4 s and offsets its timestamps to the segment's absolute
//   time, so segments from different runs line up.
//
// remux — the original video copied untouched (HEVC, HDR and 4K included)
//   into fragmented MP4, which Apple requires for HEVC. A copy can only be
//   cut at the source's own keyframes, so the playlist is built from the
//   MKV's keyframe index (mkvKeyframes.ts). ffmpeg can't be told to cut at
//   chosen keyframes, so each run cuts at *every* keyframe into small
//   "pieces", and a playlist segment is served as its pieces joined
//   together; every segment boundary is a keyframe, where ffmpeg always
//   cuts, so this holds whichever run made which piece. Copying runs at
//   disk speed, so a run that gets far ahead of the viewer is stopped and
//   restarted when they catch up, rather than copying the whole film into
//   the cache.

const SEGMENT_SECONDS = 4
// Remuxed segments are cut at the nearest keyframe at least this far on.
const REMUX_SEGMENT_SECONDS = 6
// How far past the run's newest segment a request may be and still just
// wait for the run to get there, rather than restarting it.
const RUN_LOOKAHEAD_SEGMENTS = 6
// Keep at most this much already-played video on disk per session;
// anything older is deleted and simply made again if scrubbed back to.
const KEEP_BEHIND_SECONDS = 30 * 60
// A remux run is stopped this far ahead of the viewer, and restarted once
// they're within REMUX_REFILL_SECONDS of the end of what's ready.
const REMUX_AHEAD_SECONDS = 180
const REMUX_REFILL_SECONDS = 90
// A paused video keeps its session this long.
const IDLE_MS = 20 * 60 * 1000
const MAX_SESSIONS = 6
const SEGMENT_WAIT_MS = 30_000
const SEGMENT_NAME = /^seg(\d{5})\.(ts|m4s)$/
// ffmpeg begins a seek in a file with B-frames this much before the time
// asked for (fftools' "dts heuristic", 3/23 s), which would land on the
// keyframe before the one we want; a remux run adds it back, plus a frame's
// fraction so rounding never lands short.
const BFRAME_SEEK_SHIFT = 3 / 23
const SEEK_MARGIN_SECONDS = 0.02
// Remuxed timestamps start this far in, so B-frames' decode times — a few
// frames before their presentation times — never go negative at the start.
const REMUX_TIMESTAMP_PAD = 1

export type HlsVariant =
  | { kind: 'transcode'; rung: TranscodeRung }
  | { kind: 'remux'; audio: 'copy' | 'convert' }

export function variantKey(variant: HlsVariant): string {
  return variant.kind === 'transcode'
    ? `transcode:${variant.rung.height}:${variant.rung.kbps}`
    : `remux:${variant.audio}`
}

// The playlist URL's query → which kind of session. No query (apps from
// before direct play) is a 1080p transcode, as it always was.
export function variantFromQuery(query: Record<string, unknown>): HlsVariant {
  if (query.mode === 'remux') {
    return { kind: 'remux', audio: query.audio === 'convert' ? 'convert' : 'copy' }
  }
  const height = parseInt(String(query.h ?? ''), 10)
  const rung = TRANSCODE_LADDER.find((r) => r.height === height) ?? TRANSCODE_LADDER[0]
  return { kind: 'transcode', rung }
}

export interface HlsDeps {
  ffmpegPath: string
  resolveMediaPath(mediaType: string, id: number): string | null
  probe(filePath: string): Promise<MediaProbe>
  // The MKV's keyframe times, or null if it has no usable index.
  keyframes(filePath: string): Promise<number[] | null>
  // ffmpeg video encoder arguments (hardware when available) for a size
  // and bitrate.
  videoArgs(rung: TranscodeRung): Promise<string[]>
  // Who's asking — a device id, or 'local' / 'legacy'. Sessions are only
  // served back to their owner.
  ownerOf(res: express.Response): string
  // Folder the session folders go in (Settings can point this at a data
  // drive instead of the system drive).
  cacheDir(): string
  log(message: string): void
  // Called for every playlist and segment request with what it's for
  // ('movie:12'); false = refuse it (the admin stopped this stream).
  onMediaRequest(req: express.Request, res: express.Response, mediaKey: string): boolean
}

interface Run {
  proc: ChildProcess
  startSegment: number
  playlist: string
  exited: boolean
  watcher: NodeJS.Timeout | null
}

interface RemuxState {
  keyframes: number[]
  // Added to a keyframe's time to get the -ss that lands exactly on it.
  seekBias: number
  videoCodec: string | null
  audioChannels: number | null
  // Start time (ms, snapped to a keyframe) → piece file.
  pieces: Map<number, string>
  // A run reached the end of the file.
  endReached: boolean
  lastRequested: number
}

interface Session {
  id: string
  owner: string
  mediaKey: string
  variantKey: string
  variant: HlsVariant
  filePath: string
  durationSeconds: number
  // Where each segment starts on the file's timeline.
  starts: number[]
  dir: string
  run: Run | null
  // Transcode: segments ffmpeg has finished.
  completed: Set<number>
  remux: RemuxState | null
  lastAccess: number
}

const sessions = new Map<string, Session>()

function killRun(session: Session): void {
  const run = session.run
  if (run?.watcher) clearInterval(run.watcher)
  if (run && !run.exited) run.proc.kill('SIGKILL')
  session.run = null
}

function stopSession(session: Session): void {
  sessions.delete(session.id)
  killRun(session)
  // ffmpeg may still hold the last segment open for a moment after kill.
  setTimeout(() => rmSync(session.dir, { recursive: true, force: true }), 2000)
}

// The admin stopped this viewer's stream from the dashboard.
export function stopHlsSessionsFor(owner: string, mediaKey: string): void {
  for (const session of [...sessions.values()]) {
    if (session.owner === owner && session.mediaKey === mediaKey) stopSession(session)
  }
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

// Transcoded segments are SEGMENT_SECONDS long except the last. A leftover
// of under a second is folded into the last segment rather than listed on
// its own: ffmpeg only starts a segment at a forced keyframe, and a
// keyframe that late usually has no frame left to land on, so such a tiny
// segment would never be written and the player would stall at the very
// end.
export function segmentCount(durationSeconds: number): number {
  return Math.max(1, Math.ceil(durationSeconds / SEGMENT_SECONDS - 0.25))
}

// Remuxed segments start at keyframes at least REMUX_SEGMENT_SECONDS apart;
// a keyframe within a second of the end doesn't start a segment of its own.
export function remuxSegmentStarts(keyframes: number[], durationSeconds: number): number[] {
  const starts = [keyframes[0]]
  for (const k of keyframes) {
    if (k - starts[starts.length - 1] >= REMUX_SEGMENT_SECONDS && durationSeconds - k >= 1) {
      starts.push(k)
    }
  }
  return starts
}

function segmentLengths(starts: number[], durationSeconds: number): number[] {
  // The first segment is counted from 0 so the lengths add up to the
  // file's duration even when its first keyframe is a few ms in.
  return starts.map(
    (s, i) => (i + 1 < starts.length ? starts[i + 1] : durationSeconds) - (i === 0 ? 0 : s)
  )
}

// Builds the full VOD playlist for a transcode.
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

// Builds the full VOD playlist for a remux (fragmented MP4).
export function remuxPlaylist(
  starts: number[],
  durationSeconds: number,
  initUrl: string,
  segmentUrl: (index: number) => string
): string {
  const lengths = segmentLengths(starts, durationSeconds)
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...lengths))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MAP:URI="${initUrl}"`
  ]
  lengths.forEach((length, i) => {
    lines.push(`#EXTINF:${Math.max(0.001, length).toFixed(3)},`, segmentUrl(i))
  })
  lines.push('#EXT-X-ENDLIST', '')
  return lines.join('\n')
}

function segmentName(index: number, ext: 'ts' | 'm4s'): string {
  return `seg${String(index).padStart(5, '0')}.${ext}`
}

function readText(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Transcode runs

// ffmpeg rewrites its own playlist only after a segment is fully written,
// so a segment listed there is complete.
function refreshCompleted(session: Session): void {
  const run = session.run
  if (!run) return
  const text = readText(join(session.dir, run.playlist))
  if (!text) return
  for (const line of text.split('\n')) {
    const m = SEGMENT_NAME.exec(line.trim())
    if (m) session.completed.add(parseInt(m[1], 10))
  }
}

async function startTranscodeRun(
  deps: HlsDeps,
  session: Session,
  startSegment: number,
  rung: TranscodeRung
): Promise<void> {
  killRun(session)
  const startSeconds = session.starts[startSegment]
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
    ...(await deps.videoArgs(rung)),
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
  spawnRun(deps, session, startSegment, playlist, args)
}

function spawnRun(
  deps: HlsDeps,
  session: Session,
  startSegment: number,
  playlist: string,
  args: string[]
): Run {
  const startSeconds = session.starts[startSegment]
  deps.log(`HLS RUN session=${session.id} start=${startSeconds}s args=${JSON.stringify(args)}`)
  const proc = spawn(deps.ffmpegPath, args)
  const run: Run = { proc, startSegment, playlist, exited: false, watcher: null }
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
    if (run.watcher) clearInterval(run.watcher)
    // The last piece is only listed once ffmpeg finishes the file.
    if (session.remux && code === 0 && session.run === run) {
      refreshPieces(session)
      session.remux.endReached = true
    }
    deps.log(
      `HLS RUN EXIT session=${session.id} start=${startSeconds}s code=${code} signal=${signal}${stderrTail ? `\n${stderrTail}` : ''}`
    )
  })
  session.run = run
  return run
}

// ---------------------------------------------------------------------------
// Remux runs

// The keyframe nearest t, if within a frame or so; t itself otherwise
// (a keyframe the index didn't list). In milliseconds.
function snapMs(keyframes: number[], t: number): number {
  let lo = 0
  let hi = keyframes.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (keyframes[mid] < t) lo = mid + 1
    else hi = mid
  }
  for (const i of [lo - 1, lo]) {
    if (i >= 0 && Math.abs(keyframes[i] - t) < 0.02) return Math.round(keyframes[i] * 1000)
  }
  return Math.round(t * 1000)
}

// Reads the run's own playlist: each listed piece is complete, and starts
// where the ones before it add up to.
function refreshPieces(session: Session): void {
  const run = session.run
  const remux = session.remux
  if (!run || !remux) return
  const text = readText(join(session.dir, run.playlist))
  if (!text) return
  let t = session.starts[run.startSegment]
  let length = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const inf = /^#EXTINF:([\d.]+)/.exec(line)
    if (inf) {
      length = parseFloat(inf[1])
    } else if (line.endsWith('.m4s')) {
      const key = snapMs(remux.keyframes, t)
      if (!remux.pieces.has(key)) remux.pieces.set(key, line)
      t += length
    }
  }
}

function remuxReady(session: Session, index: number): boolean {
  const remux = session.remux!
  const starts = session.starts
  if (!remux.pieces.has(Math.round(starts[index] * 1000))) return false
  return index + 1 < starts.length
    ? remux.pieces.has(Math.round(starts[index + 1] * 1000))
    : remux.endReached
}

function piecesOf(session: Session, index: number): string[] {
  const from = Math.round(session.starts[index] * 1000)
  const to =
    index + 1 < session.starts.length ? Math.round(session.starts[index + 1] * 1000) : Infinity
  return [...session.remux!.pieces.entries()]
    .filter(([key]) => key >= from && key < to)
    .sort((a, b) => a[0] - b[0])
    .map(([, file]) => join(session.dir, file))
}

function startRemuxRun(deps: HlsDeps, session: Session, startSegment: number): void {
  killRun(session)
  const remux = session.remux!
  const variant = session.variant as Extract<HlsVariant, { kind: 'remux' }>
  // The first run reads from the very start; any other seeks to exactly
  // its segment's keyframe. Either way a frame at file time t gets
  // timestamp t - (file start) + pad, so every run's pieces line up.
  const seek =
    startSegment === 0 ? null : Math.max(0, session.starts[startSegment] + remux.seekBias)
  const runId = `${startSegment}-${Date.now()}`
  const playlist = `run-${runId}.m3u8`
  const channels = remux.audioChannels ?? 2
  const audioArgs =
    variant.audio === 'copy'
      ? ['-c:a', 'copy']
      : channels > 2
        ? // Surround stays surround: E-AC-3 plays on every Apple device and
          // passes through to a soundbar or receiver.
          ['-c:a', 'eac3', '-b:a', '640k', '-ac', String(Math.min(channels, 6))]
        : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    ...(seek === null ? [] : ['-ss', seek.toFixed(4)]),
    '-i',
    session.filePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'copy',
    // Apple players only accept HEVC tagged hvc1 (and H.264 as avc1).
    ...(remux.videoCodec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    ...(remux.videoCodec === 'h264' ? ['-tag:v', 'avc1'] : []),
    ...audioArgs,
    '-output_ts_offset',
    ((seek ?? 0) + REMUX_TIMESTAMP_PAD).toFixed(4),
    '-muxdelay',
    '0',
    '-f',
    'hls',
    // Cut at every keyframe (see the top of this file).
    '-hls_time',
    '0.001',
    '-hls_segment_type',
    'fmp4',
    // Keeps the absolute timestamps in each fragment rather than restarting
    // from zero for every run.
    '-hls_segment_options',
    'movflags=+frag_discont',
    '-hls_playlist_type',
    'event',
    '-hls_list_size',
    '0',
    '-hls_fmp4_init_filename',
    `init-${runId}.mp4`,
    '-hls_segment_filename',
    join(session.dir, `p${runId}-%05d.m4s`),
    join(session.dir, playlist)
  ]
  const run = spawnRun(deps, session, startSegment, playlist, args)
  // Stops the run once it's far enough ahead of the viewer (paused, or
  // just watching) — copying is much faster than playback.
  run.watcher = setInterval(() => {
    if (session.run !== run || run.exited) return
    refreshPieces(session)
    const head = runHead(session)
    const ahead = head >= 0 ? session.starts[head] - session.starts[remux.lastRequested] : 0
    if (ahead > REMUX_AHEAD_SECONDS) {
      deps.log(`HLS RUN PAUSED session=${session.id} ready to ${session.starts[head]}s`)
      killRun(session)
    }
  }, 500)
}

// Once the viewer is within REMUX_REFILL_SECONDS of the end of what's
// ready, carries on from there before they get to it.
function refillRemux(deps: HlsDeps, session: Session, index: number): void {
  const run = session.run
  if (run && !run.exited) return
  let next = index + 1
  while (next < session.starts.length && remuxReady(session, next)) next++
  if (next >= session.starts.length) return
  if (session.starts[next] - session.starts[index] < REMUX_REFILL_SECONDS) {
    startRemuxRun(deps, session, next)
  }
}

// ---------------------------------------------------------------------------

function refresh(session: Session): void {
  if (session.remux) refreshPieces(session)
  else refreshCompleted(session)
}

function isReady(session: Session, index: number): boolean {
  return session.remux ? remuxReady(session, index) : session.completed.has(index)
}

function runHead(session: Session): number {
  const run = session.run
  if (!run) return -1
  let head = run.startSegment - 1
  while (head + 1 < session.starts.length && isReady(session, head + 1)) head++
  return head
}

async function startRun(deps: HlsDeps, session: Session, startSegment: number): Promise<void> {
  if (session.variant.kind === 'remux') startRemuxRun(deps, session, startSegment)
  else await startTranscodeRun(deps, session, startSegment, session.variant.rung)
}

// Deletes what's well behind the segment being watched; it's made again if
// the viewer scrubs back.
function pruneBehind(session: Session, index: number): void {
  const cutoff = session.starts[index] - KEEP_BEHIND_SECONDS
  if (cutoff <= 0) return
  if (session.remux) {
    for (const [key, file] of [...session.remux.pieces]) {
      if (key < cutoff * 1000) {
        session.remux.pieces.delete(key)
        rmSync(join(session.dir, file), { force: true })
      }
    }
    return
  }
  for (const done of [...session.completed]) {
    if (session.starts[done] < cutoff) {
      session.completed.delete(done)
      rmSync(join(session.dir, segmentName(done, 'ts')), { force: true })
    }
  }
}

async function ensureSegment(deps: HlsDeps, session: Session, index: number): Promise<boolean> {
  refresh(session)
  if (isReady(session, index)) return true
  const run = session.run
  const head = runHead(session)
  const runCovers =
    run !== null && !run.exited && index >= run.startSegment && index <= head + RUN_LOOKAHEAD_SEGMENTS
  if (!runCovers) await startRun(deps, session, index)

  const deadline = Date.now() + SEGMENT_WAIT_MS
  while (Date.now() < deadline) {
    refresh(session)
    if (isReady(session, index)) return true
    if (!session.run || session.run.exited) {
      refresh(session)
      return isReady(session, index)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

// The fragmented-MP4 header every remuxed segment needs. Each run writes
// its own copy; they're identical, so any one will do.
async function ensureInit(deps: HlsDeps, session: Session): Promise<string | null> {
  const find = (): string | null => {
    const name = readdirSync(session.dir).find((f) => /^init-.*\.mp4$/.test(f))
    return name ? join(session.dir, name) : null
  }
  const deadline = Date.now() + SEGMENT_WAIT_MS
  while (Date.now() < deadline) {
    const found = find()
    if (found) return found
    if (!session.run || session.run.exited) {
      await startRun(deps, session, session.remux?.lastRequested ?? 0)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return find()
}

async function sendFiles(
  res: express.Response,
  files: string[],
  contentType: string
): Promise<void> {
  const sizes = files.map((f) => statSync(f).size)
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Length', String(sizes.reduce((a, b) => a + b, 0)))
  try {
    for (const file of files) await pipeline(createReadStream(file), res, { end: false })
    res.end()
  } catch {
    res.destroy()
  }
}

async function createSession(
  deps: HlsDeps,
  owner: string,
  mediaKey: string,
  variant: HlsVariant,
  filePath: string
): Promise<Session | { error: string }> {
  const probe = await deps.probe(filePath)
  const duration = probe.durationSeconds
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    return { error: "Can't read this file's length, so it can't be streamed." }
  }
  let starts: number[]
  let remux: RemuxState | null = null
  if (variant.kind === 'remux') {
    const keyframes = await deps.keyframes(filePath)
    if (!keyframes) return { error: "This file can't be repackaged; ask for a converted stream." }
    starts = remuxSegmentStarts(keyframes, duration)
    remux = {
      keyframes,
      seekBias:
        SEEK_MARGIN_SECONDS + (probe.hasBFrames ? BFRAME_SEEK_SHIFT : 0) - probe.startSeconds,
      videoCodec: probe.videoCodec,
      audioChannels: probe.audioChannels,
      pieces: new Map(),
      endReached: false,
      lastRequested: 0
    }
  } else {
    starts = Array.from({ length: segmentCount(duration) }, (_, i) => i * SEGMENT_SECONDS)
  }
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastAccess - b.lastAccess)[0]
    stopSession(oldest)
  }
  const id = randomUUID()
  const dir = join(deps.cacheDir(), id)
  mkdirSync(dir, { recursive: true })
  const session: Session = {
    id,
    owner,
    mediaKey,
    variantKey: variantKey(variant),
    variant,
    filePath,
    durationSeconds: duration,
    starts,
    dir,
    run: null,
    completed: new Set(),
    remux,
    lastAccess: Date.now()
  }
  sessions.set(id, session)
  return session
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
  // Asking for the same file another way (a different quality, or a
  // converted stream after the original failed) replaces the session.
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
    if (!deps.onMediaRequest(req, res, mediaKey)) {
      res.status(403).json({ error: 'stopped' })
      return
    }
    const variant = variantFromQuery(req.query)
    let session = [...sessions.values()].find((s) => s.owner === owner && s.mediaKey === mediaKey)
    if (session && session.variantKey !== variantKey(variant)) {
      stopSession(session)
      session = undefined
    }
    if (!session) {
      const created = await createSession(deps, owner, mediaKey, variant, filePath)
      if ('error' in created) {
        res.status(415).json({ error: created.error })
        return
      }
      session = created
    }
    session.lastAccess = Date.now()
    // Segment URLs are absolute and carry the same signed media link the
    // playlist was fetched with — a player doesn't pass query strings on to
    // relative URLs.
    const mt = typeof req.query.mt === 'string' ? req.query.mt : null
    const suffix = mt ? `?mt=${encodeURIComponent(mt)}` : ''
    const base = `/hls/session/${session.id}`
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(
      session.remux
        ? remuxPlaylist(
            session.starts,
            session.durationSeconds,
            `${base}/init.mp4${suffix}`,
            (i) => `${base}/${segmentName(i, 'm4s')}${suffix}`
          )
        : vodPlaylist(session.durationSeconds, (i) => `${base}/${segmentName(i, 'ts')}${suffix}`)
    )
  })

  app.get('/hls/session/:sid/:file', async (req, res) => {
    const session = sessions.get(req.params.sid)
    if (!session || session.owner !== deps.ownerOf(res)) {
      res.status(404).end()
      return
    }
    if (!deps.onMediaRequest(req, res, session.mediaKey)) {
      res.status(403).end()
      return
    }
    session.lastAccess = Date.now()

    if (req.params.file === 'init.mp4' && session.remux) {
      const init = await ensureInit(deps, session)
      if (!init) {
        res.status(503).end()
        return
      }
      await sendFiles(res, [init], 'video/mp4')
      return
    }

    const m = SEGMENT_NAME.exec(req.params.file)
    const index = m ? parseInt(m[1], 10) : -1
    if (!m || index >= session.starts.length || (m[2] === 'm4s') !== (session.remux !== null)) {
      res.status(404).end()
      return
    }
    if (session.remux) session.remux.lastRequested = index
    if (!(await ensureSegment(deps, session, index))) {
      res.status(503).end()
      return
    }
    pruneBehind(session, index)
    if (session.remux) {
      const files = piecesOf(session, index)
      refillRemux(deps, session, index)
      await sendFiles(res, files, 'video/mp4')
      return
    }
    res.setHeader('Content-Type', 'video/mp2t')
    res.sendFile(join(session.dir, segmentName(index, 'ts')))
  })
}
