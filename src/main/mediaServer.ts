import express from 'express'
import compression from 'compression'
import {
  createReadStream,
  existsSync,
  statSync,
  appendFileSync,
  writeFileSync,
  readdirSync,
  readFileSync
} from 'fs'
import { extname, resolve, sep, join, basename, dirname } from 'path'
import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { clearStaleHlsFolders, registerHlsRoutes, stopAllHlsSessions } from './hls'
import { randomBytes } from 'crypto'
import { app } from 'electron'
import { API_VERSION, type ServerVersionInfo } from '../shared/remoteAccess'
// @ts-ignore - no types shipped
import ffmpegStatic from 'ffmpeg-static'
import type { Server } from 'http'
import {
  getEpisode,
  getMovie,
  listProfiles,
  createProfile,
  renameProfile,
  deleteProfile,
  setProfilePin,
  verifyProfilePin,
  listMovies,
  listShows,
  getShow,
  listEpisodes,
  saveProgress,
  getProgress,
  setWatched,
  getContinueWatching,
  getNextEpisodeToWatch,
  getAllActivity,
  listWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  isInWatchlist,
  getLibrarySeenAt,
  markLibrarySeen
} from './repository'
import { probeFile, canDirectPlay } from './ffprobe'
import {
  authenticateDeviceKey,
  authenticateMediaToken,
  createMediaToken,
  deviceAddrsForProfile,
  redeemLoginCode,
  saveDeviceSpeed,
  type AuthenticatedDevice
} from './auth'
import { FailureLimiter, bearerToken, isMediaRoute, isPublicRemoteRoute } from './authCore'
import { revokeGuestDevicesByAddr } from './tailscaleApi'
import { logError } from './errorLog'
import { deleteSetting, getSetting, setSetting } from './db'
import type { MediaType, Profile, WatchlistMediaType } from '../shared/types'

let server: Server | null = null
let remoteServer: Server | null = null
let boundPort = 0
// Second listener for everything that arrives from other devices: the
// host's Tailscale sidecar forwards here, never to boundPort. Both listen on
// loopback only, so the port a request came in on tells local (this
// machine's own window) apart from remote (a friend's device).
let remotePort = 0

// local = this machine's own window. device = a remote device that sent a
// valid device key. legacy = a remote request with no key while "require
// login" is off (apps from before users existed). anonymous = a remote
// request to a public route (version check, redeeming a code).
type RequestAuth =
  | { kind: 'local' }
  | ({ kind: 'device' } & AuthenticatedDevice)
  | { kind: 'legacy' }
  | { kind: 'anonymous' }

function authOf(res: express.Response): RequestAuth {
  return res.locals.auth as RequestAuth
}

export function isRemoteLoginRequired(): boolean {
  return getSetting('remoteRequireLogin') === '1'
}

function authenticate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.socket.localPort !== remotePort) {
    res.locals.auth = { kind: 'local' } satisfies RequestAuth
    next()
    return
  }
  const key = bearerToken(req.headers.authorization)
  // Players that can't send a header carry a signed media link instead —
  // accepted on media routes only, never for the JSON API.
  const mediaToken = typeof req.query.mt === 'string' ? req.query.mt : null
  if (!key && mediaToken && isMediaRoute(req.path)) {
    const device = authenticateMediaToken(mediaToken)
    if (!device) {
      res.status(401).json({ error: 'signed-out' })
      return
    }
    res.locals.auth = { kind: 'device', ...device } satisfies RequestAuth
    next()
    return
  }
  if (key) {
    const device = authenticateDeviceKey(key)
    if (!device) {
      // Revoked, or the user was disabled or deleted — even with "require
      // login" off, a device that presents a dead key is signed out.
      res.status(401).json({ error: 'signed-out' })
      return
    }
    res.locals.auth = { kind: 'device', ...device } satisfies RequestAuth
    next()
    return
  }
  if (isPublicRemoteRoute(req.path)) {
    res.locals.auth = { kind: 'anonymous' } satisfies RequestAuth
    next()
    return
  }
  if (isRemoteLoginRequired()) {
    res.status(401).json({ error: 'login-required' })
    return
  }
  res.locals.auth = { kind: 'legacy' } satisfies RequestAuth
  next()
}

// The profile a device is signed in as, or null for local/legacy callers
// (which keep the pre-users behaviour: any profile, PIN permitting).
function deviceProfile(res: express.Response): Profile | null {
  const auth = authOf(res)
  return auth.kind === 'device' ? auth.profile : null
}

// Device users act only as themselves; an admin's device may act as anyone
// the same way the host's own window can (PINs still apply).
function isRestrictedDevice(res: express.Response): boolean {
  const profile = deviceProfile(res)
  return profile !== null && !profile.isAdmin
}

// child_process.spawn() talks to the real OS, not Electron's patched fs
// layer — it needs an actual on-disk path. asar-packed paths aren't real
// files, so anything shipped in resources/app.asar/... must be redirected
// to its unpacked twin at resources/app.asar.unpacked/... before spawning
// (this is a no-op in dev, where there's no asar at all).
const ffmpegPath = (ffmpegStatic as string).replace('app.asar', 'app.asar.unpacked')

const APP_VERSION = app.getVersion()

// 1 MB of random bytes, sent repeatedly: incompressible over the wire, and
// cheap to produce for every test.
const SPEEDTEST_CHUNK = randomBytes(1024 * 1024)
const SPEEDTEST_DEFAULT_BYTES = 16 * 1024 * 1024
const SPEEDTEST_MAX_BYTES = 64 * 1024 * 1024
const transcodeLogPath = join(app.getPath('userData'), 'transcode.log')
const MAX_TRANSCODE_LOG_BYTES = 2 * 1024 * 1024

function logTranscode(message: string): void {
  try {
    if (existsSync(transcodeLogPath) && statSync(transcodeLogPath).size > MAX_TRANSCODE_LOG_BYTES) {
      writeFileSync(
        transcodeLogPath,
        `[${new Date().toISOString()}] (log rotated — exceeded ${MAX_TRANSCODE_LOG_BYTES} bytes)\n`
      )
    }
    appendFileSync(transcodeLogPath, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    /* best-effort diagnostics only */
  }
}

function resolveMediaPath(mediaType: string, id: number): string | null {
  if (mediaType === 'movie') return getMovie(id)?.filePath ?? null
  if (mediaType === 'episode') return getEpisode(id)?.filePath ?? null
  return null
}

// Sidecar subtitles, not a DB-tracked feature — discovered fresh on every
// request by listing the video's own directory, so dropping a new .srt next
// to a file just works without a rescan. Matches anything that starts with
// the video's basename and ends in .srt/.vtt (e.g. "Movie (2020).en.srt").
interface SubtitleTrack {
  index: number
  label: string
  path: string
}

function findSubtitleTracks(videoFilePath: string): SubtitleTrack[] {
  const dir = dirname(videoFilePath)
  const base = basename(videoFilePath, extname(videoFilePath))
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter((f) => {
      const ext = extname(f).toLowerCase()
      return (ext === '.srt' || ext === '.vtt') && f.toLowerCase().startsWith(base.toLowerCase())
    })
    .map((f, index) => {
      const withoutExt = f.slice(0, f.length - extname(f).length)
      const suffix = withoutExt.slice(base.length).replace(/^[.\-_]+/, '')
      return { index, label: suffix || `Track ${index + 1}`, path: join(dir, f) }
    })
}

// <track> requires WebVTT — SRT's only real difference is the comma
// decimal separator in timestamps and the missing "WEBVTT" header.
function srtToVtt(srt: string): string {
  const body = srt.replace(/\r+/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  return `WEBVTT\n\n${body}`
}

function streamDirect(req: express.Request, res: express.Response, filePath: string): void {
  const stat = statSync(filePath)
  const range = req.headers.range
  const contentType = extname(filePath).toLowerCase() === '.mp4' ? 'video/mp4' : 'video/quicktime'

  if (!range) {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes'
    })
    createReadStream(filePath).pipe(res)
    return
  }

  const match = /bytes=(\d+)-(\d*)/.exec(range)
  const start = match ? parseInt(match[1], 10) : 0
  const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': contentType
  })
  createReadStream(filePath, { start, end }).pipe(res)
}

type HardwareEncoder = 'h264_nvenc' | 'h264_qsv' | 'h264_amf'

// Quality presets, one tier up from the previous speed-first defaults.
// Benchmarked on this host (AMD Radeon RX Vega, h264_amf) with a synthetic
// 1080p30 source: 'speed' sustains ~5.7x realtime, 'balanced' ~5.0x,
// 'quality' ~3.1x — even the slowest of the three has comfortable headroom
// over live playback, so 'balanced' was picked as a solid quality gain
// while keeping a generous safety margin real content (more complex than
// a test pattern) can eat into without risking a transcode falling behind
// and stalling playback. nvenc/qsv couldn't be benchmarked on this
// machine (no matching hardware) — bumped by the same one conservative
// tier rather than guessed aggressively.
const HARDWARE_ENCODER_ARGS: Record<HardwareEncoder, string[]> = {
  h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'll'],
  h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'fast'],
  h264_amf: ['-c:v', 'h264_amf', '-quality', 'balanced']
}

function probeEncoder(codec: HardwareEncoder): Promise<boolean> {
  return new Promise((resolveProbe) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolveProbe(ok)
    }
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(ffmpegPath, [
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=64x64:d=0.5',
        '-c:v',
        codec,
        '-frames:v',
        '5',
        '-f',
        'null',
        '-'
      ])
    } catch {
      finish(false)
      return
    }
    proc.on('error', () => finish(false))
    proc.on('exit', (code) => finish(code === 0))
  })
}

let hardwareEncoderPromise: Promise<HardwareEncoder | null> | null = null

// Probed once and cached, never assumed — this same binary may run on a
// machine with a different GPU or none at all. Each candidate is proven
// against a real (if tiny) encode, not just checked against ffmpeg's
// -encoders list, so a missing/broken driver falls back to libx264
// (software, already battle-tested) automatically rather than breaking
// playback. Runs eagerly at server startup (see startMediaServer) so the
// first real transcode request doesn't pay this latency.
function detectHardwareEncoder(): Promise<HardwareEncoder | null> {
  if (!hardwareEncoderPromise) {
    hardwareEncoderPromise = (async () => {
      for (const codec of ['h264_nvenc', 'h264_qsv', 'h264_amf'] as const) {
        try {
          if (await probeEncoder(codec)) {
            logTranscode(`Hardware encoder available: ${codec}`)
            return codec
          }
        } catch {
          /* try next candidate */
        }
      }
      logTranscode('No working hardware encoder found — using libx264 (software).')
      return null
    })()
  }
  return hardwareEncoderPromise
}

// Bitrate caps for HLS transcodes: 1080p at most, ~8 Mbps average and 10
// Mbps peak — fits a remote friend's connection while looking good on a TV.
const HLS_RATE_ARGS = ['-b:v', '8M', '-maxrate', '10M', '-bufsize', '16M']
const HLS_ENCODER_ARGS: Record<HardwareEncoder, string[]> = {
  h264_nvenc: [...HARDWARE_ENCODER_ARGS.h264_nvenc, ...HLS_RATE_ARGS],
  h264_qsv: [...HARDWARE_ENCODER_ARGS.h264_qsv, ...HLS_RATE_ARGS],
  h264_amf: ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'vbr_peak', ...HLS_RATE_ARGS]
}
// Scale down only (never up) to 1080p; 8-bit 4:2:0 is what every H.264
// player and hardware encoder accepts (10-bit HDR sources included).
const HLS_SCALE_FILTER = ['-vf', "scale=w='min(1920,iw)':h=-2,format=yuv420p"]

async function hlsVideoArgs(filePath: string): Promise<{ args: string[]; copy: boolean }> {
  const probe = await probeFile(filePath)
  if (probe.videoCodec === 'h264') return { args: ['-c:v', 'copy'], copy: true }
  const encoder = await detectHardwareEncoder()
  return {
    args: [
      ...HLS_SCALE_FILTER,
      ...(encoder
        ? HLS_ENCODER_ARGS[encoder]
        : ['-c:v', 'libx264', '-preset', 'faster', '-crf', '21', '-maxrate', '10M', '-bufsize', '16M'])
    ],
    copy: false
  }
}

export const DEFAULT_HLS_CACHE_DIR = join(tmpdir(), 'martbox-hls')

export function hlsCacheDir(): string {
  return getSetting('transcodeCacheDir') || DEFAULT_HLS_CACHE_DIR
}

// Moving the cache ends running sessions (their folders live in the old
// place) — players simply restart them on their next request.
export function setHlsCacheDir(dir: string | null): void {
  stopAllHlsSessions()
  if (dir) setSetting('transcodeCacheDir', dir)
  else deleteSetting('transcodeCacheDir')
  clearStaleHlsFolders(hlsCacheDir())
}

async function streamTranscode(
  req: express.Request,
  res: express.Response,
  filePath: string,
  videoCodec: string | null
): Promise<void> {
  const startSeconds = parseFloat((req.query.t as string) || '0') || 0

  const hardwareEncoder = videoCodec === 'h264' ? null : await detectHardwareEncoder()

  const args = [
    '-ss',
    String(startSeconds),
    '-i',
    filePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    ...(videoCodec === 'h264'
      ? ['-c:v', 'copy']
      : hardwareEncoder
        ? HARDWARE_ENCODER_ARGS[hardwareEncoder]
        : // Benchmarked on this host: 'medium'+crf20 sustains ~5x realtime
          // on a synthetic 1080p30 source (vs. ~7.3x for the previous
          // veryfast+crf23) — a real quality step up with plenty of margin
          // left over real content's extra complexity.
          ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20']),
    // Software and hardware encoders alike default to a long keyframe
    // interval (libx264: ~250 frames, ~10s at 24-30fps; hardware encoders
    // have their own similarly long defaults), and -movflags frag_keyframe
    // only flushes a fragment at a keyframe — so without this, the player
    // waits out an entire GOP before it gets the first playable bytes, then
    // stalls again at every GOP boundary. Forcing one every 2s (time-based,
    // so it holds regardless of source framerate or which encoder is
    // active) turns that into small, frequent fragments.
    '-force_key_frames',
    'expr:gte(t,n_forced*2)',
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    '-f',
    'mp4',
    'pipe:1'
  ]

  logTranscode(
    `START file=${filePath} videoCodec=${videoCodec} hwEncoder=${hardwareEncoder ?? 'none (software)'} startSeconds=${startSeconds} range=${req.headers.range ?? 'none'} args=${JSON.stringify(args)}`
  )

  const ff = spawn(ffmpegPath, args)
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'none' })
  ff.stdout.pipe(res)

  let stderrTail = ''
  ff.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-20000)
  })

  const cleanup = (): void => {
    if (!ff.killed) ff.kill('SIGKILL')
  }
  req.on('close', () => {
    logTranscode(`CLIENT DISCONNECTED file=${filePath}\n--- ffmpeg stderr tail ---\n${stderrTail}`)
    cleanup()
  })
  ff.on('error', (err) => {
    logTranscode(`SPAWN ERROR file=${filePath} error=${err.message}`)
    cleanup()
  })
  ff.on('exit', (code, signal) => {
    logTranscode(
      `EXIT file=${filePath} code=${code} signal=${signal}\n--- ffmpeg stderr tail ---\n${stderrTail}`
    )
  })
}

// Without this, any tailnet member could read or overwrite any other
// profile's watch progress just by passing a different profileId — there's
// no session tying a request to a specific profile. Profiles without a PIN
// stay open (that's what choosing not to set one means); PIN-protected ones
// require proving it on every call, since there's no cheaper way to bind an
// anonymous HTTP request to "yes, this caller really is that profile"
// without building real sessions.
// A 4-digit PIN is only 10,000 guesses — remote callers get 5 wrong tries
// per profile, then that profile's PIN is locked for 15 minutes. The host's
// own window is never limited, so the owner can't be locked out of their
// own server.
const pinLimiters = new Map<number, FailureLimiter>()

function checkPin(res: express.Response, profileId: number, pin: string): boolean {
  if (authOf(res).kind === 'local') return verifyProfilePin(profileId, pin)
  let limiter = pinLimiters.get(profileId)
  if (!limiter) {
    limiter = new FailureLimiter(5, 5 * 60 * 1000, 15 * 60 * 1000)
    pinLimiters.set(profileId, limiter)
  }
  if (limiter.isLocked()) return false
  const ok = verifyProfilePin(profileId, pin)
  if (ok) limiter.recordSuccess()
  else limiter.recordFailure()
  return ok
}

function hasProfileAccess(
  res: express.Response,
  profileId: number,
  pin: string | undefined
): boolean {
  const profile = listProfiles().find((p) => p.id === profileId)
  if (!profile) return false
  if (!profile.hasPin) return true
  return !!pin && checkPin(res, profileId, pin)
}

function canActAsProfile(res: express.Response, profileId: number, pin: string | undefined): boolean {
  const own = deviceProfile(res)
  if (own && own.id === profileId) return true
  if (isRestrictedDevice(res)) return false
  return hasProfileAccess(res, profileId, pin)
}

// Mirrors the same reads/writes exposed over Electron IPC in ipc.ts, so a
// friend's MartBox install (client mode) can reach this host's catalog and
// watch history over the tailnet instead of its own empty local DB. Thin
// wrappers only — all business logic stays in repository.ts.
function registerMetadataApi(app: express.Express): void {
  const json = express.json()

  // Lets client apps tell "server too old" / "app too old" apart from a
  // plain connection failure. Keep this route working without any session —
  // a client checks it before anything else.
  app.get('/api/version', (_req, res) => {
    const info: ServerVersionInfo = { appVersion: APP_VERSION, apiVersion: API_VERSION }
    res.json(info)
  })
  // Redeeming a login code is how a remote device gets its key. Public by
  // necessity — FailureLimiter in auth.ts throttles guessing.
  app.post('/api/auth/redeem', json, (req, res) => {
    const result = redeemLoginCode(
      String(req.body?.code ?? ''),
      String(req.body?.deviceName ?? ''),
      typeof req.body?.tailscaleAddr === 'string' ? req.body.tailscaleAddr : null
    )
    if (!result.ok) {
      res.status(result.reason === 'locked' ? 429 : 400).json({
        error: result.reason,
        retryAfterMs: result.retryAfterMs
      })
      return
    }
    res.json({ deviceKey: result.deviceKey, profile: result.profile })
  })
  // A signed media link for this device (see authCore.ts). Clients append
  // it as ?mt= to stream/image/probe/subtitle URLs and refetch before it
  // expires.
  app.get('/api/auth/media-token', (_req, res) => {
    const auth = authOf(res)
    if (auth.kind !== 'device') {
      res.status(400).json({ error: 'Only a signed-in device can get a media token' })
      return
    }
    res.json(createMediaToken(auth.device.id))
  })
  app.get('/api/auth/me', (_req, res) => {
    const auth = authOf(res)
    res.json({
      kind: auth.kind,
      profile: auth.kind === 'device' ? auth.profile : null,
      device: auth.kind === 'device' ? auth.device : null,
      loginRequired: isRemoteLoginRequired()
    })
  })

  // Speed test: a client downloads up to `bytes` of incompressible data and
  // times it (compression() skips octet-stream). Needs a key like any other
  // route; capped so it can't be used to tie up the host's upload.
  app.get('/api/speedtest/download', (req, res) => {
    const requested = parseInt(req.query.bytes as string, 10)
    const total = Math.min(
      Number.isFinite(requested) && requested > 0 ? requested : SPEEDTEST_DEFAULT_BYTES,
      SPEEDTEST_MAX_BYTES
    )
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(total),
      'Cache-Control': 'no-store'
    })
    let sent = 0
    const writeMore = (): void => {
      while (sent < total) {
        const chunk = SPEEDTEST_CHUNK.subarray(0, Math.min(SPEEDTEST_CHUNK.length, total - sent))
        sent += chunk.length
        if (!res.write(chunk)) {
          res.once('drain', writeMore)
          return
        }
      }
      res.end()
    }
    req.on('close', () => res.removeAllListeners('drain'))
    writeMore()
  })
  // The device reports its own result so the admin sees it under Users.
  app.post('/api/speedtest/result', json, (req, res) => {
    const auth = authOf(res)
    const mbps = Number(req.body?.mbps)
    const latencyMs = Number(req.body?.latencyMs)
    if (auth.kind !== 'device' || !Number.isFinite(mbps) || !Number.isFinite(latencyMs)) {
      res.status(400).json({ error: 'Only a signed-in device can report a speed test' })
      return
    }
    saveDeviceSpeed(auth.device.id, Math.max(0, mbps), Math.max(0, latencyMs))
    res.json({ ok: true })
  })

  // A signed-in friend only sees (and can only pick) their own profile.
  app.get('/api/profiles', (_req, res) => {
    const own = deviceProfile(res)
    res.json(own && !own.isAdmin ? listProfiles().filter((p) => p.id === own.id) : listProfiles())
  })
  // Users are created by the admin (Settings → Users on the host), not by
  // whoever is connected.
  app.post('/api/profiles', json, (req, res) => {
    if (isRestrictedDevice(res)) {
      res.status(403).json({ error: 'Only the server admin can add users' })
      return
    }
    res.json(createProfile(req.body.name, req.body.avatarId))
  })
  // Anyone who can reach this port at all (any tailnet member, once invited)
  // can call these with no session/identity of their own — there's no
  // concept of "which profile is this request acting as" at the HTTP layer.
  // The admin profile is the one thing that must never be renameable or
  // deletable this way, since losing it would mean losing the ability to
  // administer the server at all. (The renderer already hides this UI from
  // non-admins; this is the server-side backstop for a request crafted
  // directly against the API, bypassing that UI.)
  app.patch('/api/profiles/:id', json, (req, res) => {
    const id = parseInt(req.params.id, 10)
    if (isRestrictedDevice(res)) {
      res.status(403).json({ error: 'Only the server admin can rename users' })
      return
    }
    if (listProfiles().find((p) => p.id === id)?.isAdmin) {
      res.status(403).json({ error: 'Cannot rename the admin profile remotely' })
      return
    }
    renameProfile(id, req.body.name)
    res.json({ ok: true })
  })
  app.delete('/api/profiles/:id', (req, res) => {
    const id = parseInt(req.params.id, 10)
    if (isRestrictedDevice(res)) {
      res.status(403).json({ error: 'Only the server admin can remove users' })
      return
    }
    if (listProfiles().find((p) => p.id === id)?.isAdmin) {
      res.status(403).json({ error: 'Cannot delete the admin profile remotely' })
      return
    }
    // Same as deleting on the host itself: the user's tailnet devices go too.
    const addrs = deviceAddrsForProfile(id)
    deleteProfile(id)
    revokeGuestDevicesByAddr(addrs).catch((err) => logError('revokeGuestDevicesByAddr', err))
    res.json({ ok: true })
  })

  // Attempting a PIN is inherently permission-less (it's the login step
  // itself) — no requester identity needed, just the guess and the answer.
  app.post('/api/profiles/:id/verify-pin', json, (req, res) => {
    res.json({ ok: checkPin(res, parseInt(req.params.id, 10), String(req.body.pin ?? '')) })
  })
  // Changing a PIN is different — same self-or-admin rule as the local IPC
  // path (profiles:setPin), re-enforced here since this endpoint is
  // reachable directly, bypassing that check entirely.
  app.post('/api/profiles/:id/pin', json, (req, res) => {
    const targetId = parseInt(req.params.id, 10)
    // A signed-in device is that user — it can't claim to be someone else.
    const requestingProfileId = deviceProfile(res)?.id ?? (req.body.requestingProfileId as number)
    const requester = listProfiles().find((p) => p.id === requestingProfileId)
    if (!requester) {
      res.status(400).json({ error: 'Unknown profile' })
      return
    }
    if (requestingProfileId !== targetId && !requester.isAdmin) {
      res.status(403).json({ error: "Only the admin can change another profile's PIN" })
      return
    }
    setProfilePin(targetId, req.body.pin ?? null)
    res.json({ ok: true })
  })

  app.get('/api/movies', (req, res) => {
    const libraryId = req.query.libraryId ? parseInt(req.query.libraryId as string, 10) : undefined
    res.json(listMovies(libraryId))
  })
  app.get('/api/movies/:id', (req, res) => res.json(getMovie(parseInt(req.params.id, 10))))

  app.get('/api/shows', (req, res) => {
    const libraryId = req.query.libraryId ? parseInt(req.query.libraryId as string, 10) : undefined
    res.json(listShows(libraryId))
  })
  app.get('/api/shows/:id', (req, res) => res.json(getShow(parseInt(req.params.id, 10))))
  app.get('/api/shows/:id/episodes', (req, res) =>
    res.json(listEpisodes(parseInt(req.params.id, 10)))
  )
  app.get('/api/shows/:id/nextEpisode', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    if (!canActAsProfile(res, profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    res.json(getNextEpisodeToWatch(profileId, parseInt(req.params.id, 10)))
  })
  app.get('/api/episodes/:id', (req, res) => res.json(getEpisode(parseInt(req.params.id, 10))))

  app.get('/api/progress', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    const mediaType = req.query.mediaType as MediaType
    const mediaId = parseInt(req.query.mediaId as string, 10)
    if (!canActAsProfile(res, profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    res.json(getProgress(profileId, mediaType, mediaId))
  })
  app.post('/api/progress', json, (req, res) => {
    const { profileId, mediaType, mediaId, positionSeconds, durationSeconds, pin } = req.body
    if (!canActAsProfile(res, profileId, pin)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    saveProgress(profileId, mediaType, mediaId, positionSeconds, durationSeconds)
    res.json({ ok: true })
  })
  app.post('/api/progress/watched', json, (req, res) => {
    const { profileId, mediaType, mediaId, watched, pin } = req.body
    if (!canActAsProfile(res, profileId, pin)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    setWatched(profileId, mediaType, mediaId, watched)
    res.json({ ok: true })
  })

  app.get('/api/continueWatching', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    if (!canActAsProfile(res, profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    res.json(getContinueWatching(profileId))
  })

  app.get('/api/activity', (_req, res) => {
    if (isRestrictedDevice(res)) {
      res.status(403).json({ error: 'Activity is only visible to the server admin' })
      return
    }
    res.json(getAllActivity())
  })

  app.get('/api/watchlist', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    if (!canActAsProfile(res, profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    res.json(listWatchlist(profileId))
  })
  app.get('/api/watchlist/has', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    if (!canActAsProfile(res, profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    const mediaType = req.query.mediaType as WatchlistMediaType
    const mediaId = parseInt(req.query.mediaId as string, 10)
    res.json({ inWatchlist: isInWatchlist(profileId, mediaType, mediaId) })
  })
  app.post('/api/watchlist', json, (req, res) => {
    const { profileId, mediaType, mediaId, pin } = req.body
    if (!canActAsProfile(res, profileId, pin)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    addToWatchlist(profileId, mediaType, mediaId)
    res.json({ ok: true })
  })
  app.post('/api/watchlist/remove', json, (req, res) => {
    const { profileId, mediaType, mediaId, pin } = req.body
    if (!canActAsProfile(res, profileId, pin)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    removeFromWatchlist(profileId, mediaType, mediaId)
    res.json({ ok: true })
  })

  app.get('/api/librarySeenAt', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    if (!canActAsProfile(res, profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    res.json(getLibrarySeenAt(profileId))
  })
  app.post('/api/librarySeenAt', json, (req, res) => {
    const { profileId, mediaType, pin } = req.body
    if (!canActAsProfile(res, profileId, pin)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    markLibrarySeen(profileId, mediaType)
    res.json({ ok: true })
  })
}

export function startMediaServer(imageCacheDir: string): Promise<number> {
  const app = express()

  // Library lists can run into thousands of entries as JSON — meaningful
  // over a local socket, much more so over the tailnet link a remote client
  // reads it through. compression skips binary
  // content-types (video streams, images) by default, so this only affects
  // the JSON/text API responses, not playback.
  app.use(compression())
  app.use(authenticate)

  registerMetadataApi(app)
  registerHlsRoutes(app, {
    ffmpegPath,
    resolveMediaPath,
    videoArgs: hlsVideoArgs,
    ownerOf: (res) => {
      const auth = authOf(res)
      return auth.kind === 'device' ? `device:${auth.device.id}` : auth.kind
    },
    cacheDir: hlsCacheDir,
    log: logTranscode
  })

  app.get('/stream/:mediaType/:id', async (req, res) => {
    const { mediaType, id } = req.params
    const filePath = resolveMediaPath(mediaType, parseInt(id, 10))
    if (!filePath || !existsSync(filePath)) {
      res.status(404).end()
      return
    }
    const probe = await probeFile(filePath)
    const directPlay = canDirectPlay(probe, extname(filePath))
    logTranscode(
      `REQUEST file=${filePath} probe=${JSON.stringify(probe)} ext=${extname(filePath)} directPlay=${directPlay}`
    )
    if (directPlay) {
      streamDirect(req, res, filePath)
    } else {
      await streamTranscode(req, res, filePath, probe.videoCodec)
    }
  })

  app.get('/probe/:mediaType/:id', async (req, res) => {
    const { mediaType, id } = req.params
    const filePath = resolveMediaPath(mediaType, parseInt(id, 10))
    if (!filePath || !existsSync(filePath)) {
      res.status(404).json(null)
      return
    }
    const probe = await probeFile(filePath)
    res.json({ ...probe, directPlay: canDirectPlay(probe, extname(filePath)) })
  })

  app.get('/subtitles/:mediaType/:id', (req, res) => {
    const { mediaType, id } = req.params
    const filePath = resolveMediaPath(mediaType, parseInt(id, 10))
    if (!filePath || !existsSync(filePath)) {
      res.json([])
      return
    }
    res.json(findSubtitleTracks(filePath).map((t) => ({ index: t.index, label: t.label })))
  })

  app.get('/subtitles/:mediaType/:id/:index', (req, res) => {
    const { mediaType, id } = req.params
    const filePath = resolveMediaPath(mediaType, parseInt(id, 10))
    if (!filePath || !existsSync(filePath)) {
      res.status(404).end()
      return
    }
    const track = findSubtitleTracks(filePath)[parseInt(req.params.index, 10)]
    if (!track) {
      res.status(404).end()
      return
    }
    try {
      const raw = readFileSync(track.path, 'utf8')
      const vtt = extname(track.path).toLowerCase() === '.srt' ? srtToVtt(raw) : raw
      res.setHeader('Content-Type', 'text/vtt')
      res.send(vtt)
    } catch {
      res.status(500).end()
    }
  })

  app.get('/image', (req, res) => {
    const raw = req.query.path as string
    if (!raw) {
      res.status(400).end()
      return
    }
    const resolved = resolve(raw)
    const cacheDirPrefix = resolve(imageCacheDir) + sep
    // Windows' filesystem is case-insensitive, but Electron's userData path
    // (and thus imageCacheDir) can resolve with different casing between
    // launches (e.g. "MartBox" vs "martbox") even though both point at the
    // same folder — compare case-insensitively on win32 so a legitimate
    // cached image never gets rejected as if it were a path-traversal attempt.
    const isWithinCacheDir =
      process.platform === 'win32'
        ? resolved.toLowerCase().startsWith(cacheDirPrefix.toLowerCase())
        : resolved.startsWith(cacheDirPrefix)
    if (!isWithinCacheDir) {
      res.status(403).end()
      return
    }
    if (!existsSync(resolved)) {
      res.status(404).end()
      return
    }
    res.sendFile(resolved)
  })

  // Fire-and-forget: runs in the background while the server starts
  // accepting connections, so the first real transcode request doesn't pay
  // the probe's latency (it awaits the same cached promise, already
  // resolved by the time anyone's actually pressed play).
  void detectHardwareEncoder()

  const listen = (): Promise<{ server: Server; port: number }> =>
    new Promise((resolveListen) => {
      const s = app.listen(0, '127.0.0.1', () => {
        const address = s.address()
        resolveListen({ server: s, port: typeof address === 'object' && address ? address.port : 0 })
      })
    })

  return (async () => {
    const local = await listen()
    const remote = await listen()
    server = local.server
    boundPort = local.port
    remoteServer = remote.server
    remotePort = remote.port
    return boundPort
  })()
}

// For this machine's own window and the renderer — never hand this to the
// Tailscale sidecar.
export function getMediaServerPort(): number {
  return boundPort
}

// What the host's Tailscale sidecar forwards to: every request here goes
// through the login check.
export function getMediaServerRemotePort(): number {
  return remotePort
}

export function stopMediaServer(): void {
  stopAllHlsSessions()
  server?.close()
  remoteServer?.close()
}
