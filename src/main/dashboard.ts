import type { Server } from 'http'
import type { Socket } from 'net'
import type express from 'express'
import type {
  DashboardDevice,
  DashboardHardware,
  DashboardSnapshot,
  DashboardStream,
  MediaType,
  StreamState
} from '../shared/types'

// Live state for the host's Dashboard (Settings → Dashboard in the host
// app): who's watching what right now, and how much upload it's using.
// Everything here is in memory — history and stats come later (v3).
//
// A stream exists while its player is active: the apps send a heartbeat
// every 10 s (playing / paused / buffering), and every media byte sent is
// counted against it. One quiet for STREAM_TIMEOUT_MS has ended.
//
// Upload is measured from the sockets themselves (bytesWritten), so it's
// what actually went out, for every kind of request — direct files, HLS
// segments and API calls alike.

const STREAM_TIMEOUT_MS = 60_000
const SAMPLE_INTERVAL_MS = 2000
const SAMPLE_COUNT = 150 // 5 minutes
const RATE_WINDOW_MS = 10_000
const STALL_WINDOW_MS = 5 * 60_000
// A stopped stream's player can't simply start it again straight away.
const STOP_BLOCK_MS = 60_000

export interface StreamOwner {
  // 'device:<id>', 'local' (this PC) or 'legacy' (an app signed in the old
  // way, before login codes).
  key: string
  deviceId: number | null
  deviceName: string
  profileName: string
  profileAvatarId: string | null
}

export interface MediaInfo {
  title: string
  subtitle: string
  posterPath: string | null
  durationSeconds: number | null
}

interface Stream {
  key: string
  owner: StreamOwner
  mediaType: MediaType
  mediaId: number
  info: MediaInfo
  positionSeconds: number
  state: StreamState
  method: DashboardStream['method']
  reason: string | null
  // What the stream is expected to take from the upload.
  expectedKbps: number | null
  channel: string | null
  startedAt: number
  lastSeen: number
  // (time, bytes) for the current rate.
  recentBytes: { t: number; bytes: number }[]
  lastStallCount: number | null
  stallTimes: number[]
}

const streams = new Map<string, Stream>()
const stopped = new Map<string, { message: string; until: number }>()
const stopListeners: ((ownerKey: string, mediaType: MediaType, mediaId: number) => void)[] = []

let lookupMedia: (mediaType: MediaType, mediaId: number) => MediaInfo | null = () => null

export function setMediaLookup(fn: typeof lookupMedia): void {
  lookupMedia = fn
}

export function streamKey(ownerKey: string, mediaType: MediaType, mediaId: number): string {
  return `${ownerKey}|${mediaType}|${mediaId}`
}

function touch(owner: StreamOwner, mediaType: MediaType, mediaId: number): Stream | null {
  const key = streamKey(owner.key, mediaType, mediaId)
  let stream = streams.get(key)
  if (!stream) {
    const info = lookupMedia(mediaType, mediaId)
    if (!info) return null
    // One device plays one thing at a time: starting something new ends
    // what it was playing.
    // ('legacy' is every older app at once, so it's left alone.)
    if (owner.key !== 'legacy') {
      for (const other of streams.values()) {
        if (other.owner.key === owner.key && other.key !== key) streams.delete(other.key)
      }
    }
    stream = {
      key,
      owner,
      mediaType,
      mediaId,
      info,
      positionSeconds: 0,
      state: 'playing',
      method: null,
      reason: null,
      expectedKbps: null,
      channel: null,
      startedAt: Date.now(),
      lastSeen: Date.now(),
      recentBytes: [],
      lastStallCount: null,
      stallTimes: []
    }
    streams.set(key, stream)
  }
  stream.owner = owner
  stream.lastSeen = Date.now()
  return stream
}

// /api/playback decided how this file is sent.
export function notePlaybackDecision(
  owner: StreamOwner,
  mediaType: MediaType,
  mediaId: number,
  method: NonNullable<DashboardStream['method']>,
  reason: string,
  // The file's real length, better than the library's rounded runtime.
  durationSeconds: number | null = null,
  expectedKbps: number | null = null
): void {
  const stream = touch(owner, mediaType, mediaId)
  if (!stream) return
  stream.method = method
  stream.reason = reason
  stream.expectedKbps = expectedKbps
  if (durationSeconds && durationSeconds > 0) stream.info.durationSeconds = durationSeconds
}

// The player's heartbeat (or a progress save, which says less).
export function noteHeartbeat(
  owner: StreamOwner,
  mediaType: MediaType,
  mediaId: number,
  positionSeconds: number,
  state: StreamState | null,
  stallCount: number | null,
  // Set when it's playing on a Live Channel ("5 · Movie Night").
  channel: string | null = null
): void {
  const stream = touch(owner, mediaType, mediaId)
  if (!stream) return
  if (channel !== null) stream.channel = channel
  if (Number.isFinite(positionSeconds) && positionSeconds >= 0) {
    stream.positionSeconds = positionSeconds
  }
  if (state) stream.state = state
  if (stallCount !== null && Number.isFinite(stallCount)) {
    // The app counts stalls since the player opened; each increase is a
    // new one.
    if (stream.lastStallCount !== null && stallCount > stream.lastStallCount) {
      for (let i = stream.lastStallCount; i < stallCount; i++) stream.stallTimes.push(Date.now())
    }
    stream.lastStallCount = stallCount
  }
}

// ---------------------------------------------------------------------------
// Bytes

interface TrackedSocket {
  last: number
  ownerKey: string | null
  // The media response currently being written on it, if any.
  media: { ownerKey: string; mediaType: MediaType; mediaId: number } | null
}

const sockets = new Map<Socket, TrackedSocket>()
const totalSamples: { t: number; mbps: number }[] = []
let bytesSinceSample = 0
interface DeviceUsage {
  day: string
  bytes: number
  recent: { t: number; bytes: number }[]
}

const deviceBytes = new Map<string, DeviceUsage>()

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function account(entry: TrackedSocket, bytes: number): void {
  if (bytes <= 0) return
  const now = Date.now()
  bytesSinceSample += bytes
  if (entry.ownerKey) {
    let usage = deviceBytes.get(entry.ownerKey)
    if (!usage || usage.day !== today()) {
      usage = { day: today(), bytes: 0, recent: [] }
      deviceBytes.set(entry.ownerKey, usage)
    }
    usage.bytes += bytes
    usage.recent.push({ t: now, bytes })
  }
  if (entry.media) {
    const { ownerKey, mediaType, mediaId } = entry.media
    const stream = streams.get(streamKey(ownerKey, mediaType, mediaId))
    if (stream) {
      stream.recentBytes.push({ t: now, bytes })
      stream.lastSeen = now
    }
  }
}

function collect(socket: Socket, entry: TrackedSocket): void {
  const written = socket.bytesWritten
  account(entry, written - entry.last)
  entry.last = written
}

// Counts everything the remote (tailnet) listener sends.
export function watchRemoteServer(server: Server): void {
  server.on('connection', (socket: Socket) => {
    const entry: TrackedSocket = { last: 0, ownerKey: null, media: null }
    sockets.set(socket, entry)
    socket.on('close', () => {
      collect(socket, entry)
      sockets.delete(socket)
    })
  })
}

// Ties a request's socket to who made it (for per-device totals) and, for
// media, to what's playing (for per-stream rates). Keep-alive sockets carry
// one request at a time, so the latest request's owner is the right one.
export function attributeRequest(
  req: express.Request,
  ownerKey: string,
  media?: { mediaType: MediaType; mediaId: number }
): void {
  const entry = sockets.get(req.socket)
  if (!entry) return
  collect(req.socket, entry)
  entry.ownerKey = ownerKey
  entry.media = media ? { ownerKey, ...media } : null
}

function rate(samples: { t: number; bytes: number }[], now: number): number {
  while (samples.length > 0 && samples[0].t < now - RATE_WINDOW_MS) samples.shift()
  const bytes = samples.reduce((sum, s) => sum + s.bytes, 0)
  return (bytes * 8) / (RATE_WINDOW_MS / 1000) / 1e6
}

function tick(): void {
  for (const [socket, entry] of sockets) collect(socket, entry)
  const now = Date.now()
  totalSamples.push({ t: now, mbps: (bytesSinceSample * 8) / (SAMPLE_INTERVAL_MS / 1000) / 1e6 })
  bytesSinceSample = 0
  while (totalSamples.length > SAMPLE_COUNT) totalSamples.shift()
  for (const stream of [...streams.values()]) {
    if (now - stream.lastSeen > STREAM_TIMEOUT_MS) streams.delete(stream.key)
  }
  for (const [key, block] of [...stopped]) {
    if (block.until < now) stopped.delete(key)
  }
}

setInterval(tick, SAMPLE_INTERVAL_MS).unref()

// What the other remote devices' active (not paused) streams are expected
// to take from the upload — for fitting a new stream into what's left.
export function committedRemoteKbps(exceptOwnerKey: string): number {
  let total = 0
  for (const stream of streams.values()) {
    if (!stream.owner.key.startsWith('device:') || stream.owner.key === exceptOwnerKey) continue
    if (stream.state === 'paused') continue
    total += stream.expectedKbps ?? 0
  }
  return total
}

// ---------------------------------------------------------------------------
// Stopping a stream

export function onStreamStopped(
  fn: (ownerKey: string, mediaType: MediaType, mediaId: number) => void
): void {
  stopListeners.push(fn)
}

export function stopStream(key: string, message: string): boolean {
  const stream = streams.get(key)
  if (!stream) return false
  stopped.set(key, { message: message.trim().slice(0, 200), until: Date.now() + STOP_BLOCK_MS })
  streams.delete(key)
  for (const fn of stopListeners) fn(stream.owner.key, stream.mediaType, stream.mediaId)
  return true
}

// The admin's message if this stream was just stopped ('' if none was
// given), else null.
export function stoppedMessage(
  ownerKey: string,
  mediaType: MediaType,
  mediaId: number
): string | null {
  const block = stopped.get(streamKey(ownerKey, mediaType, mediaId))
  return block && block.until > Date.now() ? block.message : null
}

// ---------------------------------------------------------------------------
// Snapshot

export interface DeviceRecord {
  id: number
  name: string
  profileName: string
  tailscaleAddr: string | null
  speedMbps: number | null
  latencyMs: number | null
  speedTestedAt: string | null
  lastSeenAt: string | null
}

export interface PeerRecord {
  addr?: string
  online: boolean
  path: 'direct' | 'relayed' | 'idle'
}

export interface ConversionRecord {
  owner: string
  mediaKey: string
  kind: 'transcode' | 'remux'
  height: number | null
  running: boolean
  speed: number | null
  fps: number | null
}

export function snapshot(
  devices: DeviceRecord[],
  peers: PeerRecord[] | null,
  uploadCapacityMbps: number | null,
  conversions: ConversionRecord[] = [],
  hardware: DashboardHardware = EMPTY_HARDWARE
): DashboardSnapshot {
  const now = Date.now()
  const streamList: DashboardStream[] = [...streams.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((s) => {
      while (s.stallTimes.length > 0 && s.stallTimes[0] < now - STALL_WINDOW_MS) {
        s.stallTimes.shift()
      }
      return {
        key: s.key,
        deviceName: s.owner.deviceName,
        profileName: s.owner.profileName,
        profileAvatarId: s.owner.profileAvatarId,
        mediaType: s.mediaType,
        mediaId: s.mediaId,
        title: s.info.title,
        subtitle: s.info.subtitle,
        posterPath: s.info.posterPath,
        positionSeconds: s.positionSeconds,
        durationSeconds: s.info.durationSeconds,
        state: s.state,
        method: s.method,
        reason: s.reason,
        mbps: rate(s.recentBytes, now),
        recentStalls: s.stallTimes.length,
        startedAt: s.startedAt,
        channel: s.channel,
        conversion: conversionFor(conversions, s)
      }
    })
  const deviceList: DashboardDevice[] = devices.map((d) => {
    const usage = deviceBytes.get(`device:${d.id}`)
    const current = usage && usage.day === today() ? usage : null
    const peer =
      d.tailscaleAddr && peers ? peers.find((p) => p.addr === d.tailscaleAddr) : undefined
    return {
      deviceId: d.id,
      deviceName: d.name,
      profileName: d.profileName,
      path: peer ? peer.path : null,
      online: peer ? peer.online : null,
      speedMbps: d.speedMbps,
      latencyMs: d.latencyMs,
      speedTestedAt: d.speedTestedAt,
      lastSeenAt: d.lastSeenAt,
      bytesToday: current?.bytes ?? 0,
      mbps: current ? rate(current.recent, now) : 0
    }
  })
  return {
    streams: streamList,
    network: {
      samples: [...totalSamples],
      currentMbps: totalSamples.length ? totalSamples[totalSamples.length - 1].mbps : 0,
      uploadCapacityMbps,
      devices: deviceList
    },
    hardware
  }
}

const EMPTY_HARDWARE: DashboardHardware = {
  cpuModel: '',
  cpuPercent: 0,
  memoryUsedBytes: 0,
  memoryTotalBytes: 0,
  encoder: '',
  decoder: '',
  conversionsRunning: 0,
  disks: []
}

function conversionFor(
  conversions: ConversionRecord[],
  stream: Stream
): DashboardStream['conversion'] {
  const match = conversions.find(
    (c) => c.owner === stream.owner.key && c.mediaKey === `${stream.mediaType}:${stream.mediaId}`
  )
  if (!match) return null
  const { kind, height, running, speed, fps } = match
  return { kind, height, running, speed, fps }
}

// For tests.
export function resetDashboard(): void {
  streams.clear()
  stopped.clear()
  sockets.clear()
  totalSamples.length = 0
  deviceBytes.clear()
  bytesSinceSample = 0
}
