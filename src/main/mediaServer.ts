import express from 'express'
import { registerMusicRoutes } from './music'
import { registerMusicPersonalRoutes } from './musicPersonal'
import { yearInReview } from './watchLog'
import { avatarPath, removeAvatar, saveAvatar } from './avatars'
import {
  addToCollection,
  collectionsContaining,
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  moveInCollection,
  removeFromCollection,
  updateCollection
} from './collections'
import { getMarkers } from './markers'
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
import { cpuMemory, diskSpace } from './systemStats'
import { checkAlerts, currentAlerts } from './alerts'
import { historyStats, startHistory } from './history'
import {
  clearStaleHlsFolders,
  hlsConversions,
  registerHlsRoutes,
  BFRAME_SEEK_SHIFT,
  SEEK_MARGIN_SECONDS,
  stopAllHlsSessions,
  stopHlsSessionsFor
} from './hls'
import {
  attributeRequest,
  committedRemoteKbps,
  noteHeartbeat,
  notePlaybackDecision,
  onStreamStopped,
  setMediaLookup,
  snapshot,
  stopStream,
  stoppedMessage,
  watchRemoteServer,
  type StreamOwner
} from './dashboard'
import { getLastRemoteAccessStatus } from './tsnetSidecar'
import {
  annotateTitles,
  cancelRequest,
  createRequest,
  listRequests,
  pendingRequestCount,
  setRequestStatus,
  titleDetails
} from './requests'
import { discoverForRequests, requestTitleInfo, searchForRequests } from './tmdb'
import { channelGuide, channelNow, listChannels, rebuildAllChannels } from './channels'
import { randomBytes } from 'crypto'
import { app, Notification } from 'electron'
import { API_VERSION, type ServerVersionInfo } from '../shared/remoteAccess'
// @ts-ignore - no types shipped
import ffmpegStatic from 'ffmpeg-static'
import type { Server } from 'http'
import {
  getEpisode,
  getMovie,
  listLibraries,
  listProfiles,
  setProfileAvatarColor,
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
import { probeFile, canDirectPlay, keyframeAtOrBefore, type MediaProbe } from './ffprobe'
import { readMkvKeyframes } from './mkvKeyframes'
import {
  decidePlayback,
  type ClientCaps,
  type PlaybackMethod,
  type QualityChoice,
  type TranscodeRung,
  SDR_COLOR_TAGS,
  toneMapFilters
} from './playback'
import {
  authenticateDeviceKey,
  authenticateMediaToken,
  createMediaToken,
  deviceAddrsForProfile,
  redeemLoginCode,
  deviceTailnetAddr,
  listDevices,
  saveDeviceSpeed,
  type AuthenticatedDevice
} from './auth'
import { FailureLimiter, bearerToken, isMediaRoute, isPublicRemoteRoute } from './authCore'
import { revokeGuestDevicesByAddr } from './tailscaleApi'
import { logError } from './errorLog'
import { deleteSetting, getSetting, setSetting } from './db'
import type {
  DashboardSnapshot,
  MediaType,
  Profile,
  StreamState,
  WatchlistMediaType
} from '../shared/types'

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

// --- Dashboard (dashboard.ts): who's watching what ---

// Same keys the HLS sessions use: 'device:<id>', 'local' or 'legacy'.
function ownerKeyOf(res: express.Response): string {
  const auth = authOf(res)
  return auth.kind === 'device' ? `device:${auth.device.id}` : auth.kind
}

function streamOwner(res: express.Response, profileId?: number): StreamOwner {
  const auth = authOf(res)
  if (auth.kind === 'device') {
    return {
      key: ownerKeyOf(res),
      deviceId: auth.device.id,
      deviceName: auth.device.name,
      profileName: auth.profile.name,
      profileAvatarId: auth.profile.avatarId
    }
  }
  const profile = profileId ? listProfiles().find((p) => p.id === profileId) : undefined
  return {
    key: ownerKeyOf(res),
    deviceId: null,
    deviceName: auth.kind === 'local' ? 'This PC' : 'Older app',
    profileName: profile?.name ?? '',
    profileAvatarId: profile?.avatarId ?? null
  }
}

function isMediaType(value: unknown): value is MediaType {
  return value === 'movie' || value === 'episode'
}

setMediaLookup((mediaType, mediaId) => {
  if (mediaType === 'movie') {
    const movie = getMovie(mediaId)
    if (!movie) return null
    return {
      title: movie.title,
      subtitle: movie.year ? String(movie.year) : '',
      posterPath: movie.posterPath,
      durationSeconds: movie.runtimeMinutes ? movie.runtimeMinutes * 60 : null
    }
  }
  const episode = getEpisode(mediaId)
  if (!episode) return null
  const show = getShow(episode.showId)
  return {
    title: show?.title ?? episode.title,
    subtitle: `S${episode.seasonNumber} · E${episode.episodeNumber} · ${episode.title}`,
    posterPath: show?.posterPath ?? null,
    durationSeconds: episode.durationSeconds
  }
})

// Direct-play responses in flight, so stopping a stream can cut them off.
const directResponses = new Set<{ ownerKey: string; mediaKey: string; res: express.Response }>()

onStreamStopped((ownerKey, mediaType, mediaId) => {
  const mediaKey = `${mediaType}:${mediaId}`
  stopHlsSessionsFor(ownerKey, mediaKey)
  for (const entry of [...directResponses]) {
    if (entry.ownerKey === ownerKey && entry.mediaKey === mediaKey) entry.res.destroy()
  }
})

// Playback on this PC (the host app's own player) — its progress saves go
// straight to the database, not through HTTP.
// "5 · Movie Night" for a channel id, for the dashboard.
function channelLabel(channelId: number): string | null {
  if (!Number.isInteger(channelId) || channelId <= 0) return null
  const channel = listChannels().find((c) => c.id === channelId)
  return channel ? `${channel.number} · ${channel.name}` : null
}

export function noteLocalPlayback(
  profileId: number,
  mediaType: MediaType,
  mediaId: number,
  positionSeconds: number,
  state: StreamState | null = null,
  channelId: number | null = null
): void {
  const profile = listProfiles().find((p) => p.id === profileId)
  noteHeartbeat(
    {
      key: 'local',
      deviceId: null,
      deviceName: 'This PC',
      profileName: profile?.name ?? '',
      profileAvatarId: profile?.avatarId ?? null
    },
    mediaType,
    mediaId,
    positionSeconds,
    state,
    null,
    channelId ? channelLabel(channelId) : null
  )
}

export function dashboardSnapshot(): DashboardSnapshot {
  const profiles = listProfiles()
  const devices = listDevices().map((d) => ({
    id: d.id,
    name: d.name,
    profileName: profiles.find((p) => p.id === d.profileId)?.name ?? '',
    tailscaleAddr: deviceTailnetAddr(d.id),
    speedMbps: d.speedMbps,
    latencyMs: d.latencyMs,
    speedTestedAt: d.speedTestedAt,
    lastSeenAt: d.lastSeenAt
  }))
  const capacity = parseFloat(getSetting('uploadCapacityMbps') ?? '')
  const conversions = hlsConversions()
  const disks = diskSpace([
    ...listLibraries().map((l) => ({ label: l.name, path: l.path })),
    { label: 'Conversion cache', path: hlsCacheDir() }
  ])
  return snapshot(
    devices,
    getLastRemoteAccessStatus().peers ?? null,
    Number.isFinite(capacity) && capacity > 0 ? capacity : null,
    conversions,
    {
      ...cpuMemory(),
      encoder: encoderLabel,
      decoder: hardwareDecodeDisabled ? 'CPU (GPU decoding failed earlier)' : decoderLabel,
      conversionsRunning: conversions.filter((c) => c.running).length,
      disks
    },
    currentAlerts()
  )
}

// Every 30 s: raise dashboard alerts, and notify the admin on this PC once
// per problem every few hours.
function watchForProblems(): void {
  setInterval(() => {
    for (const alert of checkAlerts(dashboardSnapshot())) {
      if (Notification.isSupported()) {
        new Notification({ title: 'MartBox', body: alert.message }).show()
      }
    }
  }, 30_000).unref()
}

// Filled in once detection finishes, for the dashboard.
let encoderLabel = 'Checking…'
let decoderLabel = 'Checking…'
const ENCODER_NAMES: Record<string, string> = {
  h264_amf: 'AMD GPU (AMF)',
  h264_nvenc: 'NVIDIA GPU (NVENC)',
  h264_qsv: 'Intel GPU (Quick Sync)',
  h264_videotoolbox: 'Apple GPU (VideoToolbox)'
}

function labelCodecs(): void {
  void detectHardwareEncoder().then((encoder) => {
    encoderLabel = encoder ? ENCODER_NAMES[encoder] : 'CPU (x264)'
  })
  void detectHardwareDecoder().then((decoder) => {
    decoderLabel =
      decoder === 'd3d11va'
        ? 'GPU (D3D11VA)'
        : decoder === 'videotoolbox'
          ? 'GPU (VideoToolbox)'
          : 'CPU'
  })
}

// The upload (kbps) a new stream for this owner can use: the upload speed
// the admin entered, less 10% and less what other remote streams are
// expected to take. null when no upload speed is set (no limit).
function spareUploadKbps(ownerKey: string): number | null {
  const capacity = parseFloat(getSetting('uploadCapacityMbps') ?? '')
  if (!Number.isFinite(capacity) || capacity <= 0) return null
  return Math.max(0, capacity * 1000 * 0.9 - committedRemoteKbps(ownerKey))
}

export function stopDashboardStream(key: string, message: string): boolean {
  return stopStream(key, message)
}

export function setUploadCapacityMbps(mbps: number | null): void {
  if (mbps && Number.isFinite(mbps) && mbps > 0) setSetting('uploadCapacityMbps', String(mbps))
  else deleteSetting('uploadCapacityMbps')
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
  const contentType = /^\.(mp4|m4v)$/i.test(extname(filePath)) ? 'video/mp4' : 'video/quicktime'

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

type HardwareEncoder = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_videotoolbox'

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
  h264_amf: ['-c:v', 'h264_amf', '-quality', 'balanced'],
  // Apple's hardware encoder, for a Mac running as the server.
  h264_videotoolbox: ['-c:v', 'h264_videotoolbox', '-allow_sw', '0']
}

// HEVC output for devices that play it: the same picture at about 60% of
// the H.264 bitrate. Only with a hardware HEVC encoder — software x265 is
// too slow to keep up on a typical server CPU.
type HevcEncoder = 'hevc_nvenc' | 'hevc_qsv' | 'hevc_amf' | 'hevc_videotoolbox'

const HEVC_ENCODER_ARGS: Record<HevcEncoder, string[]> = {
  hevc_nvenc: ['-c:v', 'hevc_nvenc', '-preset', 'p5'],
  hevc_qsv: ['-c:v', 'hevc_qsv', '-preset', 'fast'],
  hevc_amf: ['-c:v', 'hevc_amf', '-quality', 'balanced', '-rc', 'vbr_peak'],
  hevc_videotoolbox: ['-c:v', 'hevc_videotoolbox', '-allow_sw', '0']
}

function probeEncoder(codec: HardwareEncoder | HevcEncoder): Promise<boolean> {
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
        // Some hardware HEVC encoders refuse tiny pictures.
        'color=c=black:s=256x256:d=0.5',
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
      for (const codec of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'] as const) {
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

let hevcEncoderPromise: Promise<HevcEncoder | null> | null = null

function detectHevcEncoder(): Promise<HevcEncoder | null> {
  if (!hevcEncoderPromise) {
    hevcEncoderPromise = (async () => {
      for (const codec of ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_videotoolbox'] as const) {
        try {
          if (await probeEncoder(codec)) {
            logTranscode(`Hardware HEVC encoder available: ${codec}`)
            return codec
          }
        } catch {
          /* try next candidate */
        }
      }
      logTranscode('No hardware HEVC encoder — conversions are H.264 only.')
      return null
    })()
  }
  return hevcEncoderPromise
}

// Hardware *decoding* of the source (D3D11VA on Windows — the Vega 56 —,
// VideoToolbox on macOS): a 4K HEVC film decoded on the CPU takes most of
// it, leaving little for tone mapping and encoding. Only used when the
// bundled ffmpeg lists it; frames come back to system memory, so the
// filters (scale, tone mapping) work unchanged. If a conversion fails
// before producing anything with it on, it's switched off until MartBox
// restarts and the conversion is retried on the CPU (hls.ts) — a driver or
// file the GPU can't handle never stops playback.
type HardwareDecoder = 'd3d11va' | 'videotoolbox'

let hardwareDecoderPromise: Promise<HardwareDecoder | null> | null = null
let hardwareDecodeDisabled = false

function detectHardwareDecoder(): Promise<HardwareDecoder | null> {
  if (!hardwareDecoderPromise) {
    hardwareDecoderPromise = new Promise((resolveDecoder) => {
      const candidate: HardwareDecoder | null =
        process.platform === 'win32'
          ? 'd3d11va'
          : process.platform === 'darwin'
            ? 'videotoolbox'
            : null
      if (!candidate) {
        resolveDecoder(null)
        return
      }
      let out = ''
      const proc = spawn(ffmpegPath, ['-hide_banner', '-hwaccels'])
      proc.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
      proc.on('error', () => resolveDecoder(null))
      proc.on('exit', () => {
        const available = out.split(/\s+/).includes(candidate)
        logTranscode(
          available
            ? `Hardware decoding available: ${candidate}`
            : 'No hardware decoding — sources are decoded on the CPU.'
        )
        resolveDecoder(available ? candidate : null)
      })
    })
  }
  return hardwareDecoderPromise
}

// Input options for re-encoding a file (before -i).
async function hwDecodeArgs(): Promise<string[]> {
  if (hardwareDecodeDisabled) return []
  const decoder = await detectHardwareDecoder()
  return decoder ? ['-hwaccel', decoder] : []
}

function disableHardwareDecode(): void {
  if (hardwareDecodeDisabled) return
  hardwareDecodeDisabled = true
  logTranscode('Hardware decoding failed for a conversion — using the CPU until MartBox restarts.')
}

// Bitrate caps for HLS transcodes, per size (playback.ts's ladder) — e.g.
// 1080p at ~8 Mbps average and 10 Mbps peak, which fits a remote friend's
// connection while looking good on a TV.
function hlsRateArgs(rung: TranscodeRung): string[] {
  const peak = Math.round(rung.kbps * 1.25)
  return ['-b:v', `${rung.kbps}k`, '-maxrate', `${peak}k`, '-bufsize', `${rung.kbps * 2}k`]
}

// Always encoded (never stream-copied): segments must be cut at exact
// 4-second boundaries so the VOD playlist's timeline is true, and copying
// can only cut where the source happens to have keyframes. (Playing the
// original untouched is the remux path in hls.ts.)
async function hlsVideoArgs(
  rung: TranscodeRung,
  probe: MediaProbe,
  codec: 'h264' | 'hevc'
): Promise<string[]> {
  const encoder = await detectHardwareEncoder()
  const rate = hlsRateArgs(rung)
  // Scale down first (never up), keeping the shape, so HDR tone mapping
  // works on the smaller picture; 8-bit 4:2:0 is what every H.264 player
  // and hardware encoder accepts.
  const maxWidth = Math.round((rung.height * 16) / 9 / 2) * 2
  const toneMap = toneMapFilters(probe)
  const filters = [`scale=w='min(${maxWidth},iw)':h=-2`, ...toneMap, 'format=yuv420p']
  const scale = ['-vf', filters.join(','), ...(toneMap.length ? SDR_COLOR_TAGS : [])]
  if (codec === 'hevc') {
    const hevc = await detectHevcEncoder()
    // Apple players only accept HEVC tagged hvc1.
    if (hevc) return [...scale, ...HEVC_ENCODER_ARGS[hevc], '-tag:v', 'hvc1', ...rate]
  }
  if (!encoder) {
    const peak = Math.round(rung.kbps * 1.25)
    return [
      ...scale,
      ...['-c:v', 'libx264', '-preset', 'faster', '-crf', '21'],
      ...['-maxrate', `${peak}k`, '-bufsize', `${rung.kbps * 2}k`]
    ]
  }
  const encoderArgs =
    encoder === 'h264_amf'
      ? ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'vbr_peak']
      : HARDWARE_ENCODER_ARGS[encoder]
  return [...scale, ...encoderArgs, ...rate]
}

// Keyframe indexes are read once per file; only MKV/WebM carry one.
const keyframeCache = new Map<string, Promise<number[] | null>>()

function fileKeyframes(filePath: string): Promise<number[] | null> {
  if (!/\.(mkv|webm)$/i.test(filePath)) return Promise.resolve(null)
  let cached = keyframeCache.get(filePath)
  if (!cached) {
    cached = readMkvKeyframes(filePath)
    keyframeCache.set(filePath, cached)
  }
  return cached
}

// What a player said it can decode, from /api/playback's query.
function capsFromQuery(query: express.Request['query']): ClientCaps {
  const list = (v: unknown): string[] =>
    typeof v === 'string' ? v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : []
  const maxHeight = parseInt(String(query.maxHeight ?? ''), 10)
  return {
    videoCodecs: list(query.video).length ? list(query.video) : ['h264'],
    maxHeight: Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : 1080,
    hevc10Bit: query.hevc10 === '1',
    dolbyVision: query.dv === '1',
    audioCodecs: list(query.audio).length ? list(query.audio) : ['aac', 'mp3']
  }
}

const QUALITY_CHOICES: QualityChoice[] = ['auto', 'original', '1080', '720', '480']
// A device's saved speed test counts for this long.
const SAVED_SPEED_MAX_AGE_MS = 24 * 60 * 60 * 1000

// The device's measured speed in kbps: what it just measured if it says,
// else its last saved speed test.
function bandwidthFor(res: express.Response, query: express.Request['query']): number | null {
  const fresh = parseFloat(String(query.bandwidthKbps ?? ''))
  if (Number.isFinite(fresh) && fresh > 0) return fresh
  const auth = authOf(res)
  if (auth.kind !== 'device') return null
  const { speedMbps, speedTestedAt } = auth.device
  if (!speedMbps || !speedTestedAt) return null
  const testedAt = Date.parse(`${speedTestedAt.replace(' ', 'T')}Z`)
  if (!Number.isFinite(testedAt) || Date.now() - testedAt > SAVED_SPEED_MAX_AGE_MS) return null
  return speedMbps * 1000
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

// Where a /stream from `requested` really starts: the keyframe at or before
// it when the video is copied, else exactly there.
async function streamStartFor(
  filePath: string,
  probe: MediaProbe,
  requested: number,
  copyVideo: boolean,
  after?: number
): Promise<number> {
  if (!copyVideo || requested <= 0) return requested
  return (await keyframeAtOrBefore(filePath, requested, probe.startSeconds, after)) ?? requested
}

// The -ss that makes ffmpeg begin both the copied video and the audio at
// that keyframe. With B-frames ffmpeg starts a seek 3/23 s before the time
// it's given, which for the keyframe itself lands on the keyframe before —
// the video then starts there while the audio starts at the time asked,
// and Chromium plays the audio early by the gap (seconds). Same shift as
// the HLS repackaging (hls.ts).
function streamSeekFor(start: number, probe: MediaProbe, copyVideo: boolean): number {
  if (!copyVideo || start <= 0) return start
  return start + SEEK_MARGIN_SECONDS + (probe.hasBFrames ? BFRAME_SEEK_SHIFT : 0)
}

async function streamTranscode(
  req: express.Request,
  res: express.Response,
  filePath: string,
  probe: MediaProbe
): Promise<void> {
  const requested = parseFloat((req.query.t as string) || '0') || 0
  const videoCodec = probe.videoCodec
  // ?copy=1: /api/playback found the desktop player decodes this video (e.g.
  // HEVC in an MKV), so it's repackaged untouched; H.264 always was.
  const copyVideo = req.query.copy === '1' || videoCodec === 'h264'
  // Copied video starts at a keyframe, so the audio has to start there too
  // (the player asked /api/stream-start for the same time).
  const startSeconds = await streamStartFor(filePath, probe, requested, copyVideo)
  const seekSeconds = streamSeekFor(startSeconds, probe, copyVideo)

  const hardwareEncoder = copyVideo ? null : await detectHardwareEncoder()
  // HDR re-encoded for the desktop player gets SDR colours too, at 1080p at
  // most — tone mapping a full 4K picture on the CPU is too slow to keep up.
  const toneMap = copyVideo ? [] : toneMapFilters(probe)
  const toneMapArgs = toneMap.length
    ? [
        '-vf',
        ["scale=w='min(1920,iw)':h=-2", ...toneMap, 'format=yuv420p'].join(','),
        ...SDR_COLOR_TAGS
      ]
    : []

  const decodeArgs = copyVideo ? [] : await hwDecodeArgs()
  // Chromium plays AAC and MP3 as they are; anything else (AC-3, E-AC-3,
  // DTS…) becomes AAC, keeping up to 5.1.
  const channels = Math.min(probe.audioChannels ?? 2, 6)
  // Copied video with B-frames shows its first frame a couple of frames in,
  // and this stream format can't say so — Chromium would play the audio
  // that much early (~80 ms at 24 fps). Converted audio waits the same.
  // After a seek the audio also starts at the shifted seek time, that much
  // after the keyframe the video starts on (streamSeekFor).
  const audioDelayMs = copyVideo ? Math.round((probe.videoDelaySeconds + seekSeconds - startSeconds) * 1000) : 0
  const audioArgs =
    probe.audioCodec === 'aac' || probe.audioCodec === 'mp3'
      ? ['-c:a', 'copy']
      : [
          ...(audioDelayMs > 0 ? ['-af', `adelay=${audioDelayMs}:all=1`] : []),
          '-c:a', 'aac', '-ac', String(channels), '-b:a', channels > 2 ? '384k' : '192k'
        ]
  const args = [
    '-ss',
    seekSeconds.toFixed(4),
    ...decodeArgs,
    '-i',
    filePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    ...toneMapArgs,
    ...(copyVideo
      ? ['-c:v', 'copy', ...(videoCodec === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
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
    ...audioArgs,
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    '-f',
    'mp4',
    'pipe:1'
  ]

  logTranscode(
    `START file=${filePath} videoCodec=${videoCodec} hwEncoder=${hardwareEncoder ?? 'none (software)'} startSeconds=${startSeconds} seek=${seekSeconds.toFixed(4)} requested=${requested} range=${req.headers.range ?? 'none'} args=${JSON.stringify(args)}`
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

// --- Live Channels (channels.ts) ---

const GUIDE_MAX_MS = 12 * 60 * 60 * 1000

// The accent presets in design/tokens.json.
const ACCENTS = ['blue', 'purple', 'pink', 'orange', 'green']

function registerChannelRoutes(app: express.Express): void {
  // Every channel's programs between from and to (Unix ms; default: the
  // last half hour to three hours ahead).
  app.get('/api/channels/guide', (req, res) => {
    const now = Date.now()
    const from = parseInt(String(req.query.from ?? ''), 10) || now - 30 * 60 * 1000
    let to = parseInt(String(req.query.to ?? ''), 10) || now + 3 * 60 * 60 * 1000
    if (to <= from) to = from + 60 * 60 * 1000
    res.json(channelGuide(from, Math.min(to, from + GUIDE_MAX_MS)))
  })

  // What a channel is playing right now and how far in — what tuning in
  // plays (through /api/playback, capped at the channel's quality).
  app.get('/api/channels/:id/now', (req, res) => {
    const now = channelNow(parseInt(req.params.id, 10))
    if (!now) {
      res.status(404).json({ error: 'No such channel, or it has nothing to play' })
      return
    }
    res.json(now)
  })
}

// --- Requests (requests.ts): friends ask for movies and shows ---

// Who's making a request: a signed-in device is its own user; this PC or an
// older app names the profile (with its PIN, if it has one).
function requestProfileId(req: express.Request, res: express.Response): number | null {
  const own = deviceProfile(res)
  if (own) return own.id
  const source = req.method === 'POST' ? (req.body ?? {}) : req.query
  const pin = typeof source.pin === 'string' ? source.pin : undefined
  const profileId = parseInt(String(source.profileId ?? ''), 10)
  if (!Number.isInteger(profileId) || !canActAsProfile(res, profileId, pin)) return null
  return profileId
}

function isRequestMediaType(value: unknown): value is 'movie' | 'tv' {
  return value === 'movie' || value === 'tv'
}

const TMDB_UNAVAILABLE = "Can't reach TMDB right now (or the server has no TMDB key)."

function registerRequestRoutes(app: express.Express): void {
  const json = express.json({ limit: '8kb' })

  app.get('/api/requests/discover', async (_req, res) => {
    const discover = await discoverForRequests()
    if (!discover) {
      res.status(502).json({ error: TMDB_UNAVAILABLE })
      return
    }
    res.json({
      sections: discover.sections.map((section) => ({
        ...section,
        items: annotateTitles(section.items)
      }))
    })
  })

  app.get('/api/requests/search', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : ''
    if (!query) {
      res.json([])
      return
    }
    const results = await searchForRequests(query)
    if (!results) {
      res.status(502).json({ error: TMDB_UNAVAILABLE })
      return
    }
    res.json(annotateTitles(results))
  })

  app.get('/api/requests/title/:mediaType/:tmdbId', async (req, res) => {
    const { mediaType } = req.params
    const tmdbId = parseInt(req.params.tmdbId, 10)
    if (!isRequestMediaType(mediaType) || !Number.isInteger(tmdbId)) {
      res.status(400).json({ error: 'Bad title' })
      return
    }
    const info = await requestTitleInfo(mediaType, tmdbId)
    if (!info) {
      res.status(502).json({ error: TMDB_UNAVAILABLE })
      return
    }
    res.json(titleDetails(info))
  })

  // The asker's own requests, newest first.
  app.get('/api/requests', (req, res) => {
    const profileId = requestProfileId(req, res)
    if (profileId === null) {
      res.status(403).json({ error: 'Sign in to see your requests' })
      return
    }
    res.json(listRequests(profileId))
  })

  app.post('/api/requests', json, async (req, res) => {
    const profileId = requestProfileId(req, res)
    if (profileId === null) {
      res.status(403).json({ error: 'Sign in to make requests' })
      return
    }
    const { mediaType, tmdbId, seasons } = req.body ?? {}
    const id = Number(tmdbId)
    if (!isRequestMediaType(mediaType) || !Number.isInteger(id)) {
      res.status(400).json({ error: 'Bad title' })
      return
    }
    const info = await requestTitleInfo(mediaType, id)
    if (!info) {
      res.status(502).json({ error: TMDB_UNAVAILABLE })
      return
    }
    const wanted = Array.isArray(seasons)
      ? seasons.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
      : null
    const result = createRequest(profileId, info, wanted)
    if (!result.ok) {
      res.status(409).json({ error: result.reason, by: result.by ?? null })
      return
    }
    // The admin hears about it on the server PC itself (no phone
    // notifications, by design).
    if (Notification.isSupported()) {
      const who = result.request.profileName || 'Someone'
      new Notification({
        title: 'New request',
        body: `${who} requested ${result.request.title}`
      }).show()
    }
    res.json(result.request)
  })

  // Taking back your own request while it's still pending.
  app.delete('/api/requests/:id', (req, res) => {
    const profileId = requestProfileId(req, res)
    if (profileId === null) {
      res.status(403).json({ error: 'Sign in to manage your requests' })
      return
    }
    const ok = cancelRequest(parseInt(req.params.id, 10), profileId)
    res.status(ok ? 200 : 404).json({ ok })
  })
}

// The admin's phone: the same dashboard and request queue as the server PC,
// for a device signed in as the admin profile. Everyone else gets a 403.
function registerAdminRoutes(app: express.Express): void {
  const json = express.json({ limit: '4kb' })
  const isAdmin = (res: express.Response): boolean => {
    if (deviceProfile(res)?.isAdmin) return true
    res.status(403).json({ error: 'Only the admin can see this' })
    return false
  }

  app.get('/api/admin/dashboard', (_req, res) => {
    if (!isAdmin(res)) return
    res.json({ ...dashboardSnapshot(), pendingRequests: pendingRequestCount() })
  })

  app.get('/api/admin/stats', (req, res) => {
    if (!isAdmin(res)) return
    const days = Number(req.query.days)
    res.json(historyStats(days === 7 || days === 30 || days === 90 ? days : 30))
  })

  app.get('/api/admin/requests', (_req, res) => {
    if (!isAdmin(res)) return
    res.json(listRequests())
  })

  app.post('/api/admin/requests/:id', json, (req, res) => {
    if (!isAdmin(res)) return
    const { status, note } = req.body ?? {}
    if (status !== 'approved' && status !== 'declined' && status !== 'pending') {
      res.status(400).json({ error: 'Bad status' })
      return
    }
    setRequestStatus(parseInt(req.params.id, 10), status, typeof note === 'string' ? note : null)
    res.json({ ok: true })
  })

  app.post('/api/admin/streams/stop', json, (req, res) => {
    if (!isAdmin(res)) return
    const { key, message } = req.body ?? {}
    if (typeof key !== 'string') {
      res.status(400).json({ error: 'Bad stream' })
      return
    }
    res.json({ ok: stopDashboardStream(key, typeof message === 'string' ? message : '') })
  })
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
  // Avatars: a photo (avatars.ts) or a colour. The person themselves, or
  // the admin for anyone.
  const mayEditProfile = (res: express.Response, targetId: number, body: any): boolean => {
    if (canActAsProfile(res, targetId, body?.pin)) return true
    const requesterId = deviceProfile(res)?.id ?? Number(body?.requestingProfileId)
    const requester = listProfiles().find((p) => p.id === requesterId)
    if (requester?.isAdmin && (deviceProfile(res) || hasProfileAccess(res, requester.id, body?.requesterPin))) {
      return true
    }
    res.status(403).json({ error: 'You can only change your own profile' })
    return false
  }
  app.get('/api/profiles/:id/avatar', (req, res) => {
    const file = avatarPath(parseInt(req.params.id, 10))
    if (!file) {
      res.status(404).end()
      return
    }
    // The URL carries ?v=<when it changed>, so it never goes stale.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.sendFile(file)
  })
  const photoJson = express.json({ limit: '12mb' })
  app.post('/api/profiles/:id/avatar', photoJson, (req, res) => {
    const id = parseInt(req.params.id, 10)
    if (!mayEditProfile(res, id, req.body)) return
    const image = Buffer.from(String(req.body?.image ?? ''), 'base64')
    if (!saveAvatar(id, image)) {
      res.status(400).json({ error: 'That file isn’t a picture MartBox can read' })
      return
    }
    res.json(listProfiles().find((p) => p.id === id))
  })
  app.post('/api/profiles/:id/avatar/delete', json, (req, res) => {
    const id = parseInt(req.params.id, 10)
    if (!mayEditProfile(res, id, req.body)) return
    removeAvatar(id)
    res.json(listProfiles().find((p) => p.id === id))
  })
  app.post('/api/profiles/:id/color', json, (req, res) => {
    const id = parseInt(req.params.id, 10)
    if (!mayEditProfile(res, id, req.body)) return
    const color = String(req.body?.color ?? '')
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      res.status(400).json({ error: 'Not a colour' })
      return
    }
    setProfileAvatarColor(id, color)
    res.json(listProfiles().find((p) => p.id === id))
  })
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
  // Year in Review (watchLog.ts): one profile's year.
  app.get('/api/year-in-review', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    if (!canActAsProfile(res, profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    const year = parseInt(req.query.year as string, 10)
    res.json(yearInReview(profileId, Number.isInteger(year) ? year : new Date().getFullYear()))
  })

  // Collections (collections.ts): everyone sees them; only the admin
  // changes them.
  const isMediaKind = (t: unknown): t is 'movie' | 'show' => t === 'movie' || t === 'show'
  const actsAsAdmin = (res: express.Response, body: any): boolean => {
    const profileId = Number(body?.profileId)
    const profile = listProfiles().find((p) => p.id === profileId)
    if (profile?.isAdmin && canActAsProfile(res, profileId, body?.pin)) return true
    res.status(403).json({ error: 'Only the admin can change collections' })
    return false
  }
  app.get('/api/collections', (_req, res) => res.json(listCollections()))
  app.get('/api/collections/containing', (req, res) => {
    const mediaType = req.query.mediaType
    const mediaId = parseInt(req.query.mediaId as string, 10)
    res.json(isMediaKind(mediaType) && mediaId ? collectionsContaining(mediaType, mediaId) : [])
  })
  app.get('/api/collections/:id', (req, res) => {
    const collection = getCollection(parseInt(req.params.id, 10))
    if (collection) res.json(collection)
    else res.status(404).json({ error: 'No such collection' })
  })
  app.post('/api/collections', json, (req, res) => {
    if (!actsAsAdmin(res, req.body)) return
    const collection = createCollection(req.body.name, req.body.description)
    if (collection) res.json(collection)
    else res.status(400).json({ error: 'A collection needs a name' })
  })
  app.post('/api/collections/:id', json, (req, res) => {
    if (!actsAsAdmin(res, req.body)) return
    const { name, description, onHome } = req.body
    const collection = updateCollection(parseInt(req.params.id, 10), { name, description, onHome })
    if (collection) res.json(collection)
    else res.status(404).json({ error: 'No such collection' })
  })
  app.post('/api/collections/:id/delete', json, (req, res) => {
    if (!actsAsAdmin(res, req.body)) return
    deleteCollection(parseInt(req.params.id, 10))
    res.json({ ok: true })
  })
  app.post('/api/collections/:id/items', json, (req, res) => {
    if (!actsAsAdmin(res, req.body)) return
    const { mediaType, mediaId, action, toIndex } = req.body
    const id = parseInt(req.params.id, 10)
    if (!isMediaKind(mediaType) || !Number.isInteger(mediaId)) {
      res.status(400).json({ error: 'Which title?' })
      return
    }
    if (action === 'remove') removeFromCollection(id, mediaType, mediaId)
    else if (action === 'move' && Number.isInteger(toIndex)) moveInCollection(id, mediaType, mediaId, toIndex)
    else if (!addToCollection(id, mediaType, mediaId)) {
      res.status(404).json({ error: 'No such collection or title' })
      return
    }
    res.json(getCollection(id))
  })

  // Where the intro and the end credits are (Skip Intro, Up Next), once
  // the season has been analysed; nulls until then.
  app.get('/api/episodes/:id/markers', (req, res) =>
    res.json(getMarkers(parseInt(req.params.id, 10)) ?? { introStart: null, introEnd: null, creditsStart: null })
  )

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
    // Apps without a heartbeat still show up on the dashboard this way.
    if (isMediaType(mediaType)) {
      const owner = streamOwner(res, profileId)
      noteHeartbeat(owner, mediaType, Number(mediaId), Number(positionSeconds), null, null)
    }
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

  // Each person's accent colour (Settings → Appearance), kept here so it
  // follows them to every device they sign in on.
  app.get('/api/appearance', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    if (!canActAsProfile(res, profileId, req.query.pin as string | undefined)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    res.json({ accent: getSetting(`accent:${profileId}`) ?? null })
  })
  app.post('/api/appearance', json, (req, res) => {
    const { profileId, pin, accent } = req.body ?? {}
    if (!canActAsProfile(res, profileId, pin)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return
    }
    if (!ACCENTS.includes(accent)) {
      res.status(400).json({ error: 'Unknown accent' })
      return
    }
    setSetting(`accent:${profileId}`, accent)
    res.json({ ok: true })
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
  // Counts what goes out to each remote device (dashboard.ts).
  app.use((req, res, next) => {
    if (req.socket.localPort === remotePort) attributeRequest(req, ownerKeyOf(res))
    next()
  })

  registerMetadataApi(app)
  registerMusicRoutes(app, (req) => req.socket.localPort === remotePort)
  registerMusicPersonalRoutes(app, canActAsProfile)
  registerRequestRoutes(app)
  registerChannelRoutes(app)
  registerAdminRoutes(app)
  registerHlsRoutes(app, {
    ffmpegPath,
    resolveMediaPath,
    probe: probeFile,
    keyframes: fileKeyframes,
    videoArgs: hlsVideoArgs,
    decodeArgs: hwDecodeArgs,
    onDecodeFailure: disableHardwareDecode,
    ownerOf: ownerKeyOf,
    onMediaRequest: (req, res, mediaKey) => {
      const [mediaType, id] = mediaKey.split(':')
      if (!isMediaType(mediaType)) return true
      const mediaId = parseInt(id, 10)
      if (stoppedMessage(ownerKeyOf(res), mediaType, mediaId) !== null) return false
      if (req.socket.localPort === remotePort) {
        attributeRequest(req, ownerKeyOf(res), { mediaType, mediaId })
      }
      return true
    },
    cacheDir: hlsCacheDir,
    log: logTranscode
  })

  // The desktop player asks before (re)starting a repackaged stream, so its
  // clock matches where the stream really begins (see streamStartFor).
  app.get('/api/stream-start/:mediaType/:id', async (req, res) => {
    const filePath = resolveMediaPath(req.params.mediaType, parseInt(req.params.id, 10))
    if (!filePath || !existsSync(filePath)) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const probe = await probeFile(filePath)
    const requested = parseFloat((req.query.t as string) || '0') || 0
    const copyVideo = req.query.copy === '1' || probe.videoCodec === 'h264'
    const after = parseFloat(req.query.after as string)
    res.json({
      seconds: await streamStartFor(filePath, probe, requested, copyVideo, Number.isFinite(after) ? after : undefined)
    })
  })

  app.get('/stream/:mediaType/:id', async (req, res) => {
    const { mediaType, id } = req.params
    const filePath = resolveMediaPath(mediaType, parseInt(id, 10))
    if (!filePath || !existsSync(filePath)) {
      res.status(404).end()
      return
    }
    if (isMediaType(mediaType)) {
      const mediaId = parseInt(id, 10)
      if (stoppedMessage(ownerKeyOf(res), mediaType, mediaId) !== null) {
        res.status(403).json({ error: 'stopped' })
        return
      }
      if (req.socket.localPort === remotePort) {
        attributeRequest(req, ownerKeyOf(res), { mediaType, mediaId })
      }
      const entry = { ownerKey: ownerKeyOf(res), mediaKey: `${mediaType}:${mediaId}`, res }
      directResponses.add(entry)
      res.on('close', () => directResponses.delete(entry))
    }
    const probe = await probeFile(filePath)
    // ?direct=1: /api/playback already decided this player takes the file
    // as it is (e.g. HEVC in MP4 on Apple devices, which canDirectPlay —
    // written for the desktop app's Chromium player — doesn't allow).
    const directPlay = req.query.direct === '1' || canDirectPlay(probe, extname(filePath))
    logTranscode(
      `REQUEST file=${filePath} probe=${JSON.stringify(probe)} ext=${extname(filePath)} directPlay=${directPlay}`
    )
    if (directPlay) {
      streamDirect(req, res, filePath)
    } else {
      await streamTranscode(req, res, filePath, probe)
    }
  })

  // How this player should play this file: the original when it can decode
  // it and its connection can carry it, converted down otherwise (see
  // playback.ts). Returns the URL to play; the player adds its media link.
  app.get('/api/playback/:mediaType/:id', async (req, res) => {
    const { mediaType, id } = req.params
    const filePath = resolveMediaPath(mediaType, parseInt(id, 10))
    if (!filePath || !existsSync(filePath)) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    if (isMediaType(mediaType)) {
      const message = stoppedMessage(ownerKeyOf(res), mediaType, parseInt(id, 10))
      if (message !== null) {
        res.status(403).json({ error: 'stopped', message })
        return
      }
    }
    const probe = await probeFile(filePath)
    const quality = QUALITY_CHOICES.find((q) => q === req.query.quality) ?? 'auto'
    const avoid = (typeof req.query.avoid === 'string' ? req.query.avoid.split(',') : []).filter(
      (m): m is PlaybackMethod => m === 'direct' || m === 'remux' || m === 'transcode'
    )
    const deviceKbps = bandwidthFor(res, req.query)
    // What's left of the server's upload after the other remote streams:
    // a new stream gets a lower quality rather than making everyone buffer.
    const spareKbps =
      req.socket.localPort === remotePort ? spareUploadKbps(ownerKeyOf(res)) : null
    const serverLimited = spareKbps !== null && (deviceKbps === null || spareKbps < deviceKbps)
    const bandwidthKbps = serverLimited ? spareKbps : deviceKbps
    const decision = decidePlayback({
      probe,
      extension: extname(filePath),
      caps: capsFromQuery(req.query),
      bandwidthKbps,
      bandwidthIsServerUpload: serverLimited,
      quality,
      // The desktop's repackaging is one continuous stream, so it needs no
      // keyframe index (HLS remuxing does).
      canRemux: req.query.client === 'desktop' || (await fileKeyframes(filePath)) !== null,
      avoid,
      hevcEncode: (await detectHevcEncoder()) !== null
    })
    // The desktop app's player (Chromium) has no HLS: its original-video
    // stream is /stream repackaging, and its conversion the /stream one.
    const desktop = req.query.client === 'desktop'
    // Desktop apps that play HLS (hls=1, 0.14.4 on) get the same keyframe-cut
    // repackaging as the other apps, audio as AAC: one continuous
    // /stream restarted at every skip couldn't keep picture and sound
    // together on Windows.
    const desktopHls =
      desktop && req.query.hls === '1' && decision.method === 'remux' && (await fileKeyframes(filePath)) !== null
    const path = desktopHls
      ? `/hls/${mediaType}/${id}/index.m3u8?mode=remux&audio=${decision.audio === 'copy' ? 'copy' : 'aac'}`
      : desktop
      ? `/stream/${mediaType}/${id}` +
        (decision.method === 'direct' ? '?direct=1' : decision.method === 'remux' ? '?copy=1' : '')
      : decision.method === 'direct'
        ? `/stream/${mediaType}/${id}?direct=1`
        : decision.method === 'remux'
          ? `/hls/${mediaType}/${id}/index.m3u8?mode=remux&audio=${decision.audio}`
          : `/hls/${mediaType}/${id}/index.m3u8?h=${decision.rung!.height}` +
            `&audio=${decision.audio}&codec=${decision.codec}`
    // A Live Channel: viewers at the same quality share the conversion.
    const hlsPath =
      req.query.channel === '1' && path.startsWith('/hls/') ? `${path}&shared=1` : path
    logTranscode(
      `PLAYBACK ${mediaType}/${id} method=${decision.method} bandwidthKbps=${bandwidthKbps ?? 'unknown'} quality=${quality} avoid=${avoid.join(',') || 'none'} — ${decision.reason}`
    )
    if (isMediaType(mediaType)) {
      const owner = streamOwner(res)
      notePlaybackDecision(
        owner,
        mediaType,
        parseInt(id, 10),
        decision.method,
        decision.reason,
        probe.durationSeconds,
        // Roughly what it will take from the upload (video + audio).
        decision.method === 'transcode'
          ? decision.rung!.kbps + 640
          : (probe.bitRateKbps ?? null)
      )
    }
    res.json({
      method: decision.method,
      path: hlsPath,
      reason: decision.reason,
      durationSeconds: probe.durationSeconds
    })
  })

  // Players report every ~10 s while open, playing or not, for the
  // dashboard. The reply tells the player if the admin stopped it.
  app.post('/api/playback/heartbeat', express.json({ limit: '4kb' }), (req, res) => {
    const { mediaType, mediaId, positionSeconds, state, stalls, channelId } = req.body ?? {}
    const id = Number(mediaId)
    if (!isMediaType(mediaType) || !Number.isInteger(id)) {
      res.status(400).json({ error: 'mediaType and mediaId are required' })
      return
    }
    const message = stoppedMessage(ownerKeyOf(res), mediaType, id)
    if (message !== null) {
      res.json({ stop: true, message })
      return
    }
    const states: StreamState[] = ['playing', 'paused', 'buffering']
    noteHeartbeat(
      streamOwner(res),
      mediaType,
      id,
      Number(positionSeconds),
      states.find((s) => s === state) ?? null,
      Number.isFinite(Number(stalls)) ? Number(stalls) : null,
      channelLabel(Number(channelId))
    )
    res.json({ stop: false })
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
  startHistory()
  watchForProblems()
  void detectHardwareEncoder()
  void detectHevcEncoder()
  void detectHardwareDecoder()
  labelCodecs()
  // Channels pick up anything added while MartBox was closed.
  void rebuildAllChannels()

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
    watchRemoteServer(remote.server)
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
