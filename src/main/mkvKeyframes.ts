import { open, type FileHandle } from 'fs/promises'

// Keyframe times of an MKV's video track, read from the file's own index
// (its Cues). Remuxing for Apple players (hls.ts) cuts segments only at
// keyframes, so it needs these up front to list every segment in the VOD
// playlist. Reading the index touches a few small regions of the file —
// fast even for a 60 GB rip on a spinning disk, where scanning every frame
// would take minutes.
//
// Returns null when the file has no usable index; the caller then
// transcodes instead.

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  info: 0x1549a966,
  timestampScale: 0x2ad7b1,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueTrack: 0xf7,
  cueClusterPosition: 0xf1,
  cluster: 0x1f43b675
}

const VIDEO_TRACK_TYPE = 1
// Index elements are small; anything bigger is a corrupt length.
const MAX_ELEMENT_BYTES = 64 * 1024 * 1024
// Segments are cut only at listed keyframes, so a sparse index would mean
// very long segments; past this, transcoding is the better experience.
const MAX_KEYFRAME_GAP_SECONDS = 30

interface Element {
  id: number
  dataStart: number
  // null = "unknown size" (live-written files).
  size: number | null
}

// EBML variable-length integer. IDs keep their length-marker bit; sizes
// don't.
function readVint(buf: Buffer, pos: number, keepMarker: boolean): { value: number; length: number } | null {
  const first = buf[pos]
  if (first === undefined || first === 0) return null
  let length = 1
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++
  if (length > 8 || pos + length > buf.length) return null
  let value = keepMarker ? first : first & (0xff >> length)
  let allOnes = value === 0xff >> length
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i]
    if (buf[pos + i] !== 0xff) allOnes = false
  }
  // All value bits set means "unknown size".
  if (!keepMarker && allOnes) return { value: -1, length }
  return { value, length }
}

function parseHeader(buf: Buffer, pos: number, absolute: number): Element | null {
  const id = readVint(buf, pos, true)
  if (!id) return null
  const size = readVint(buf, pos + id.length, false)
  if (!size) return null
  return {
    id: id.value,
    dataStart: absolute + id.length + size.length,
    size: size.value < 0 ? null : size.value
  }
}

function readUint(buf: Buffer): number {
  let value = 0
  for (const byte of buf) value = value * 256 + byte
  return value
}

// Children of an element already in memory.
function* children(buf: Buffer): Generator<{ id: number; data: Buffer }> {
  let pos = 0
  while (pos < buf.length) {
    const el = parseHeader(buf, pos, pos)
    if (!el || el.size === null || el.dataStart + el.size > buf.length) return
    yield { id: el.id, data: buf.subarray(el.dataStart, el.dataStart + el.size) }
    pos = el.dataStart + el.size
  }
}

async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await file.read(buf, 0, length, position)
  return buf.subarray(0, bytesRead)
}

async function headerAt(file: FileHandle, position: number): Promise<Element | null> {
  return parseHeader(await readAt(file, position, 16), 0, position)
}

async function elementData(file: FileHandle, el: Element): Promise<Buffer | null> {
  if (el.size === null || el.size > MAX_ELEMENT_BYTES) return null
  return readAt(file, el.dataStart, el.size)
}

export interface MkvIndex {
  keyframes: number[] | null
  // The highest bitrate over any PEAK_WINDOW_SECONDS stretch (all tracks,
  // which is what a stream of the original carries), from where the index
  // says each keyframe's cluster starts. null when the index has no
  // positions.
  peakKbps: number | null
}

export const PEAK_WINDOW_SECONDS = 10

export async function readMkvKeyframes(filePath: string): Promise<number[] | null> {
  return (await readMkvIndex(filePath)).keyframes
}

// Bitrate between index points at least `windowSeconds` apart; the highest
// is the stretch a connection has to keep up with.
export function peakKbps(points: { time: number; pos: number }[], windowSeconds = PEAK_WINDOW_SECONDS): number | null {
  const sorted = [...points].sort((a, b) => a.time - b.time)
  let peak: number | null = null
  let j = 0
  for (let i = 0; i < sorted.length; i++) {
    if (j <= i) j = i + 1
    while (j < sorted.length && sorted[j].time - sorted[i].time < windowSeconds) j++
    if (j >= sorted.length) break
    const seconds = sorted[j].time - sorted[i].time
    const bytes = sorted[j].pos - sorted[i].pos
    if (bytes <= 0) continue
    const kbps = (bytes * 8) / 1000 / seconds
    if (peak === null || kbps > peak) peak = kbps
  }
  return peak === null ? null : Math.round(peak)
}

export async function readMkvIndex(filePath: string): Promise<MkvIndex> {
  const none: MkvIndex = { keyframes: null, peakKbps: null }
  let file: FileHandle | null = null
  try {
    file = await open(filePath, 'r')
    const { size: fileSize } = await file.stat()

    const ebml = await headerAt(file, 0)
    if (!ebml || ebml.id !== ID.ebml || ebml.size === null) return none
    const segment = await headerAt(file, ebml.dataStart + ebml.size)
    if (!segment || segment.id !== ID.segment) return none
    const segmentStart = segment.dataStart

    // Where the top-level elements are: the SeekHead lists them, and the
    // ones before the first Cluster can also just be walked.
    const found = new Map<number, number>()
    const seekHeads: number[] = []
    let pos = segmentStart
    for (let i = 0; i < 64 && pos < fileSize; i++) {
      const el = await headerAt(file, pos)
      if (!el || el.id === ID.cluster || el.size === null) break
      if (!found.has(el.id)) found.set(el.id, pos)
      if (el.id === ID.seekHead) seekHeads.push(pos)
      pos = el.dataStart + el.size
    }
    const parsedSeekHeads = new Set<number>()
    while (seekHeads.length > 0) {
      const at = seekHeads.shift()!
      if (parsedSeekHeads.has(at)) continue
      parsedSeekHeads.add(at)
      const el = await headerAt(file, at)
      const data = el && (await elementData(file, el))
      if (!data) continue
      for (const seek of children(data)) {
        if (seek.id !== ID.seek) continue
        let target: number | null = null
        let position: number | null = null
        for (const field of children(seek.data)) {
          if (field.id === ID.seekId) target = readUint(field.data)
          if (field.id === ID.seekPosition) position = segmentStart + readUint(field.data)
        }
        if (target === null || position === null) continue
        if (target === ID.seekHead) seekHeads.push(position)
        else if (!found.has(target)) found.set(target, position)
      }
    }

    const load = async (id: number): Promise<Buffer | null> => {
      const at = found.get(id)
      if (at === undefined) return null
      const el = await headerAt(file!, at)
      return el && el.id === id ? elementData(file!, el) : null
    }

    let timestampScale = 1_000_000
    const info = await load(ID.info)
    for (const field of info ? children(info) : []) {
      if (field.id === ID.timestampScale) timestampScale = readUint(field.data) || timestampScale
    }

    const tracks = await load(ID.tracks)
    let videoTrack: number | null = null
    for (const entry of tracks ? children(tracks) : []) {
      if (entry.id !== ID.trackEntry) continue
      let number: number | null = null
      let type: number | null = null
      for (const field of children(entry.data)) {
        if (field.id === ID.trackNumber) number = readUint(field.data)
        if (field.id === ID.trackType) type = readUint(field.data)
      }
      if (type === VIDEO_TRACK_TYPE && number !== null) {
        videoTrack = number
        break
      }
    }
    if (videoTrack === null) return none

    const cues = await load(ID.cues)
    if (!cues) return none
    const times: number[] = []
    const points: { time: number; pos: number }[] = []
    for (const point of children(cues)) {
      if (point.id !== ID.cuePoint) continue
      let time: number | null = null
      let forVideo = false
      let clusterPos: number | null = null
      for (const field of children(point.data)) {
        if (field.id === ID.cueTime) time = readUint(field.data)
        if (field.id === ID.cueTrackPositions) {
          let track: number | null = null
          let position: number | null = null
          for (const pos of children(field.data)) {
            if (pos.id === ID.cueTrack) track = readUint(pos.data)
            if (pos.id === ID.cueClusterPosition) position = readUint(pos.data)
          }
          if (track === videoTrack) {
            forVideo = true
            clusterPos = position
          }
        }
      }
      if (time === null || !forVideo) continue
      // Milliseconds are as precise as anything that consumes these.
      const seconds = Math.round((time * timestampScale) / 1e6) / 1000
      times.push(seconds)
      if (clusterPos !== null) points.push({ time: seconds, pos: clusterPos })
    }
    return { keyframes: usableKeyframes(times), peakKbps: peakKbps(points) }
  } catch {
    return none
  } finally {
    await file?.close().catch(() => {})
  }
}

// Sorted, de-duplicated, starting at the beginning, and dense enough to cut
// reasonably sized segments — or null.
export function usableKeyframes(times: number[]): number[] | null {
  const sorted = [...new Set(times)].sort((a, b) => a - b)
  if (sorted.length < 2 || sorted[0] > 1) return null
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > MAX_KEYFRAME_GAP_SECONDS) return null
  }
  return sorted
}
