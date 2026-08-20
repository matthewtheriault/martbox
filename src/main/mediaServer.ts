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
import { Readable } from 'stream'
import { app } from 'electron'
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
  listIptvChannels,
  getIptvChannelStreamUrl,
  getAllActivity,
  listWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  isInWatchlist,
  getLibrarySeenAt,
  markLibrarySeen
} from './repository'
import { probeFile, canDirectPlay } from './ffprobe'
import type { MediaType, WatchlistMediaType } from '../shared/types'

let server: Server | null = null
let boundPort = 0

// child_process.spawn() talks to the real OS, not Electron's patched fs
// layer — it needs an actual on-disk path. asar-packed paths aren't real
// files, so anything shipped in resources/app.asar/... must be redirected
// to its unpacked twin at resources/app.asar.unpacked/... before spawning
// (this is a no-op in dev, where there's no asar at all).
const ffmpegPath = (ffmpegStatic as string).replace('app.asar', 'app.asar.unpacked')

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
function hasProfileAccess(profileId: number, pin: string | undefined): boolean {
  const profile = listProfiles().find((p) => p.id === profileId)
  if (!profile) return false
  if (!profile.hasPin) return true
  return !!pin && verifyProfilePin(profileId, pin)
}

// Mirrors the same reads/writes exposed over Electron IPC in ipc.ts, so a
// friend's MartBox install (client mode) can reach this host's catalog and
// watch history over the tailnet instead of its own empty local DB. Thin
// wrappers only — all business logic stays in repository.ts.
function registerMetadataApi(app: express.Express): void {
  const json = express.json()

  app.get('/api/profiles', (_req, res) => res.json(listProfiles()))
  app.post('/api/profiles', json, (req, res) => {
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
    if (listProfiles().find((p) => p.id === id)?.isAdmin) {
      res.status(403).json({ error: 'Cannot rename the admin profile remotely' })
      return
    }
    renameProfile(id, req.body.name)
    res.json({ ok: true })
  })
  app.delete('/api/profiles/:id', (req, res) => {
    const id = parseInt(req.params.id, 10)
    if (listProfiles().find((p) => p.id === id)?.isAdmin) {
      res.status(403).json({ error: 'Cannot delete the admin profile remotely' })
      return
    }
    deleteProfile(id)
    res.json({ ok: true })
  })

  // Attempting a PIN is inherently permission-less (it's the login step
  // itself) — no requester identity needed, just the guess and the answer.
  app.post('/api/profiles/:id/verify-pin', json, (req, res) => {
    res.json({ ok: verifyProfilePin(parseInt(req.params.id, 10), req.body.pin ?? '') })
  })
  // Changing a PIN is different — same self-or-admin rule as the local IPC
  // path (profiles:setPin), re-enforced here since this endpoint is
  // reachable directly, bypassing that check entirely.
  app.post('/api/profiles/:id/pin', json, (req, res) => {
    const targetId = parseInt(req.params.id, 10)
    const requestingProfileId = req.body.requestingProfileId as number
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
    res.json(getNextEpisodeToWatch(profileId, parseInt(req.params.id, 10)))
  })
  app.get('/api/episodes/:id', (req, res) => res.json(getEpisode(parseInt(req.params.id, 10))))

  app.get('/api/progress', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    const mediaType = req.query.mediaType as MediaType
    const mediaId = parseInt(req.query.mediaId as string, 10)
    if (!hasProfileAccess(profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    res.json(getProgress(profileId, mediaType, mediaId))
  })
  app.post('/api/progress', json, (req, res) => {
    const { profileId, mediaType, mediaId, positionSeconds, durationSeconds, pin } = req.body
    if (!hasProfileAccess(profileId, pin)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    saveProgress(profileId, mediaType, mediaId, positionSeconds, durationSeconds)
    res.json({ ok: true })
  })
  app.post('/api/progress/watched', json, (req, res) => {
    const { profileId, mediaType, mediaId, watched, pin } = req.body
    if (!hasProfileAccess(profileId, pin)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    setWatched(profileId, mediaType, mediaId, watched)
    res.json({ ok: true })
  })

  app.get('/api/continueWatching', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    if (!hasProfileAccess(profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    res.json(getContinueWatching(profileId))
  })

  app.get('/api/iptv/channels', (_req, res) => res.json(listIptvChannels()))

  app.get('/api/activity', (_req, res) => res.json(getAllActivity()))

  app.get('/api/watchlist', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    if (!hasProfileAccess(profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    res.json(listWatchlist(profileId))
  })
  app.get('/api/watchlist/has', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    if (!hasProfileAccess(profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    const mediaType = req.query.mediaType as WatchlistMediaType
    const mediaId = parseInt(req.query.mediaId as string, 10)
    res.json({ inWatchlist: isInWatchlist(profileId, mediaType, mediaId) })
  })
  app.post('/api/watchlist', json, (req, res) => {
    const { profileId, mediaType, mediaId, pin } = req.body
    if (!hasProfileAccess(profileId, pin)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    addToWatchlist(profileId, mediaType, mediaId)
    res.json({ ok: true })
  })
  app.post('/api/watchlist/remove', json, (req, res) => {
    const { profileId, mediaType, mediaId, pin } = req.body
    if (!hasProfileAccess(profileId, pin)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    removeFromWatchlist(profileId, mediaType, mediaId)
    res.json({ ok: true })
  })

  app.get('/api/librarySeenAt', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    if (!hasProfileAccess(profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    res.json(getLibrarySeenAt(profileId))
  })
  app.post('/api/librarySeenAt', json, (req, res) => {
    const { profileId, mediaType, pin } = req.body
    if (!hasProfileAccess(profileId, pin)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    markLibrarySeen(profileId, mediaType)
    res.json({ ok: true })
  })
}

const PASSTHROUGH_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']

function absolutize(base: string, ref: string): string {
  return new URL(ref.trim(), base).toString()
}

// Rewrites every non-#-prefixed line (segment/sub-playlist URL) plus URI="..."
// attributes inside #EXT-X-KEY/#EXT-X-MEDIA tags (AES-128 key fetches and
// alt audio/subtitle playlists must also transit our proxy — the browser
// has no direct route to the origin IPTV host). Master playlist -> media
// playlist -> segments all flow back through proxyLiveUrl via these
// rewritten URLs, so there's no need to special-case each HLS layer here.
function rewriteManifest(text: string, manifestUrl: string, channelId: string): string {
  const proxied = (abs: string): string => `/live/${channelId}/segment?u=${encodeURIComponent(abs)}`
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (trimmed.startsWith('#EXT-X-KEY') || trimmed.startsWith('#EXT-X-MEDIA')) {
        return trimmed.replace(/URI="([^"]+)"/, (_m, uri) => `URI="${proxied(absolutize(manifestUrl, uri))}"`)
      }
      if (trimmed.startsWith('#')) return line
      return proxied(absolutize(manifestUrl, trimmed))
    })
    .join('\n')
}

// /live/:channelId/segment forwards whatever "u" it's given (that's the
// point — HLS manifests reference their own CDN URLs, rewritten to transit
// this proxy) to a plain server-side fetch(). Without a check, anyone who
// can reach this port could use it as an open relay to probe the host's own
// loopback services or its local network — literal private/loopback/
// link-local hosts are the obvious, practical case to block; a legitimate
// IPTV segment is never going to live at 127.0.0.1 or 192.168.x.x. This
// doesn't defend against DNS rebinding (a hostname that resolves to a
// private IP only at fetch time) — narrower threat, not addressed here.
function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '0.0.0.0') return true
  if (/^127\./.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (h === '::1') return true
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true
  if (/^fe80:/i.test(h)) return true
  return false
}

async function proxyLiveUrl(
  targetUrl: string,
  channelId: string,
  req: express.Request,
  res: express.Response
): Promise<void> {
  let parsedTarget: URL
  try {
    parsedTarget = new URL(targetUrl)
  } catch {
    res.status(400).end()
    return
  }
  if (isPrivateOrLoopbackHost(parsedTarget.hostname)) {
    res.status(403).end()
    return
  }

  const controller = new AbortController()
  req.on('close', () => controller.abort())

  let upstream: Response
  try {
    upstream = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MartBox/1.0',
        ...(req.headers.range ? { Range: req.headers.range as string } : {})
      }
    })
  } catch {
    res.status(502).end()
    return
  }
  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status || 502).end()
    return
  }
  // fetch() follows redirects transparently, which could otherwise be used
  // to route around the pre-fetch loopback/private-IP check above (a public
  // host redirecting to an internal one) — re-check wherever the content
  // actually came from.
  if (upstream.url && isPrivateOrLoopbackHost(new URL(upstream.url).hostname)) {
    res.status(403).end()
    return
  }

  // Many IPTV entries route through a redirector (short links, CDN
  // dispatch, etc.) — fetch() follows the redirect transparently, but any
  // relative segment/sub-playlist URL in the manifest is relative to where
  // the content actually came from (upstream.url), not the URL we started
  // from. Resolving against the original URL silently breaks every
  // relative reference on a redirecting source.
  const finalUrl = upstream.url || targetUrl
  const urlPath = new URL(finalUrl).pathname.toLowerCase()
  const contentType = (upstream.headers.get('content-type') || '').toLowerCase()
  const looksLikeManifest = urlPath.endsWith('.m3u8') || contentType.includes('mpegurl')

  if (looksLikeManifest) {
    const text = await upstream.text()
    if (text.trimStart().startsWith('#EXTM3U')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
      res.status(200).send(rewriteManifest(text, finalUrl, channelId))
      return
    }
    res.setHeader('Content-Type', contentType || 'application/octet-stream')
    res.status(200).send(text)
    return
  }

  for (const h of PASSTHROUGH_HEADERS) {
    const v = upstream.headers.get(h)
    if (v) res.setHeader(h, v)
  }
  res.status(upstream.status)
  Readable.fromWeb(upstream.body as any).pipe(res)
}

export function startMediaServer(imageCacheDir: string): Promise<number> {
  const app = express()

  // The IPTV channel list alone can run into the thousands of entries as
  // JSON — meaningful over a local socket, much more so over the tailnet
  // link a remote client reads it through. compression skips binary
  // content-types (video streams, images) by default, so this only affects
  // the JSON/text API responses, not playback.
  app.use(compression())

  registerMetadataApi(app)

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

  app.get('/live/:channelId', async (req, res) => {
    const streamUrl = getIptvChannelStreamUrl(parseInt(req.params.channelId, 10))
    if (!streamUrl) {
      res.status(404).end()
      return
    }
    await proxyLiveUrl(streamUrl, req.params.channelId, req, res)
  })

  app.get('/live/:channelId/segment', async (req, res) => {
    const target = req.query.u as string
    if (!target || !/^https?:\/\//i.test(target)) {
      res.status(400).end()
      return
    }
    await proxyLiveUrl(target, req.params.channelId, req, res)
  })

  // Fire-and-forget: runs in the background while the server starts
  // accepting connections, so the first real transcode request doesn't pay
  // the probe's latency (it awaits the same cached promise, already
  // resolved by the time anyone's actually pressed play).
  void detectHardwareEncoder()

  return new Promise((resolvePort) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      boundPort = typeof address === 'object' && address ? address.port : 0
      resolvePort(boundPort)
    })
  })
}

export function getMediaServerPort(): number {
  return boundPort
}

export function stopMediaServer(): void {
  server?.close()
}
