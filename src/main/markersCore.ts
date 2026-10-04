// Finds the intro and end credits of TV episodes by listening for the
// stretch of audio two episodes of a season share (the theme song, the
// credits music). Pure functions here; markers.ts decodes the audio and
// stores what's found.
//
// Each episode's audio becomes one 32-bit fingerprint every HOP samples
// (Haitsma & Kalker): how the energy across 33 bands changes from one
// frame to the next. The same audio gives nearly the same bits whatever the
// encode or volume, so two episodes are lined up by voting on the time
// offset their identical fingerprints suggest, then the matched stretch is
// the longest run along that offset where the bits mostly agree.

export const SAMPLE_RATE = 5512
const FRAME = 2048
export const HOP = 128
const BANDS = 33
const LOW_HZ = 300
const HIGH_HZ = 2000
// Smoothing window for the bit error rate, in frames (~1.5 s).
const SMOOTH = 64
// Below this share of differing bits two frames count as the same audio
// (unrelated audio differs in about half).
const MATCH_BER = 0.3
// Summed band energy below which a frame counts as silence (a 16-bit
// signal around -60 dBFS across the bands).
const SILENCE = 1e7
// A shared stretch whose fingerprints barely change (a steady tone, hum)
// isn't a theme: at least this share of its frames must differ.
const MIN_VARIETY = 0.3
// Strongest offsets checked after the vote.
const CANDIDATES = 4

export const SECONDS_PER_FRAME = HOP / SAMPLE_RATE

export interface Segment {
  // Seconds into each of the two inputs.
  aStart: number
  aEnd: number
  bStart: number
  bEnd: number
}

// Mono 16-bit PCM at SAMPLE_RATE → one fingerprint per HOP samples.
export function fingerprint(pcm: Int16Array): Uint32Array {
  const frames = pcm.length >= FRAME ? Math.floor((pcm.length - FRAME) / HOP) + 1 : 0
  const out = new Uint32Array(Math.max(0, frames - 1))
  if (frames < 2) return out

  const window = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1))

  // Band edges in FFT bins, spaced logarithmically like hearing.
  const edges: number[] = []
  for (let b = 0; b <= BANDS; b++) {
    const hz = LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, b / BANDS)
    edges.push(Math.round((hz * FRAME) / SAMPLE_RATE))
  }

  const re = new Float32Array(FRAME)
  const im = new Float32Array(FRAME)
  let prev = new Float32Array(BANDS)
  let cur = new Float32Array(BANDS)
  for (let f = 0; f < frames; f++) {
    const start = f * HOP
    for (let i = 0; i < FRAME; i++) {
      re[i] = pcm[start + i] * window[i]
      im[i] = 0
    }
    fft(re, im)
    for (let b = 0; b < BANDS; b++) {
      let e = 0
      for (let k = edges[b]; k < edges[b + 1]; k++) e += re[k] * re[k] + im[k] * im[k]
      cur[b] = e
    }
    if (f > 0) {
      let bits = 0
      let energy = 0
      for (let b = 0; b < BANDS; b++) energy += cur[b]
      if (energy < SILENCE) {
        // Silence (or near it) is the same in every episode: random bits
        // so it never counts as shared audio.
        bits = Math.floor(Math.random() * 2 ** 32)
      } else {
        for (let b = 0; b < 32; b++) {
          const d = cur[b] - cur[b + 1] - (prev[b] - prev[b + 1])
          if (d > 0) bits |= 1 << b
        }
      }
      out[f - 1] = bits >>> 0
    }
    const t = prev
    prev = cur
    cur = t
  }
  return out
}

// In-place radix-2 FFT.
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

// The longest stretch of audio a and b share, at least minSeconds long, or
// null.
export function longestCommon(a: Uint32Array, b: Uint32Array, minSeconds: number): Segment | null {
  const index = new Map<number, number[]>()
  for (let j = 0; j < b.length; j++) {
    const list = index.get(b[j])
    if (list) {
      if (list.length < 32) list.push(j)
    } else index.set(b[j], [j])
  }
  const votes = new Map<number, number>()
  for (let i = 0; i < a.length; i++) {
    const list = index.get(a[i])
    if (!list) continue
    for (const j of list) {
      // Neighbouring offsets vote together: the two files' frames rarely
      // line up to the sample.
      const off = j - i
      votes.set(off, (votes.get(off) ?? 0) + 1)
    }
  }
  const ranked = [...votes.entries()]
    .map(([off, v]) => [off, v + (votes.get(off - 1) ?? 0) + (votes.get(off + 1) ?? 0)] as const)
    .sort((x, y) => y[1] - x[1])
  const tried = new Set<number>()
  let best: { start: number; end: number; off: number } | null = null
  for (const [off] of ranked) {
    if (tried.size >= CANDIDATES) break
    if (tried.has(off) || tried.has(off - 1) || tried.has(off + 1)) continue
    tried.add(off)
    const run = longestRun(a, b, off)
    if (run && variety(a, run.start, run.end) < MIN_VARIETY) continue
    if (run && (!best || run.end - run.start > best.end - best.start)) best = { ...run, off }
  }
  if (!best || (best.end - best.start) * SECONDS_PER_FRAME < minSeconds) return null
  return {
    aStart: best.start * SECONDS_PER_FRAME,
    aEnd: best.end * SECONDS_PER_FRAME,
    bStart: (best.start + best.off) * SECONDS_PER_FRAME,
    bEnd: (best.end + best.off) * SECONDS_PER_FRAME
  }
}

// Share of distinct fingerprints in a[start, end).
function variety(a: Uint32Array, start: number, end: number): number {
  if (end <= start) return 0
  return new Set(a.subarray(start, end)).size / (end - start)
}

// Along one offset (b index = a index + off): the longest run of frames whose
// smoothed bit error rate stays under MATCH_BER. Returns a-frame indices.
function longestRun(a: Uint32Array, b: Uint32Array, off: number): { start: number; end: number } | null {
  const from = Math.max(0, -off)
  const to = Math.min(a.length, b.length - off)
  if (to - from < SMOOTH) return null
  const n = to - from
  // Prefix sums of the per-frame error, so each frame's centred window
  // average is one subtraction.
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + popcount((a[from + i] ^ b[from + i + off]) >>> 0) / 32
  const half = SMOOTH / 2
  let best: { start: number; end: number } | null = null
  let runStart = -1
  for (let k = 0; k <= n; k++) {
    let matching = false
    if (k < n) {
      const lo = Math.max(0, k - half)
      const hi = Math.min(n, k + half)
      matching = (prefix[hi] - prefix[lo]) / (hi - lo) < MATCH_BER
    }
    if (matching && runStart < 0) runStart = k
    if (!matching && runStart >= 0) {
      if (!best || k - runStart > best.end - best.start) best = { start: from + runStart, end: from + k }
      runStart = -1
    }
  }
  return best
}

export interface Markers {
  introStart: number | null
  introEnd: number | null
  creditsStart: number | null
}

// Intros run 10 s to 2.5 min and start in the opening minutes; anything
// else the two episodes share there (a recap, a cold open's music) is
// left alone.
export const INTRO_SCAN_SECONDS = 600
const INTRO_MIN = 10
const INTRO_MAX = 150
// Credits are looked for in the closing minutes and run to the end.
export const CREDITS_SCAN_SECONDS = 420
const CREDITS_MIN = 15

export function introFrom(a: Uint32Array, b: Uint32Array): { start: number; end: number } | null {
  const seg = longestCommon(a, b, INTRO_MIN)
  if (!seg) return null
  const length = seg.aEnd - seg.aStart
  if (length > INTRO_MAX) return null
  return { start: round(seg.aStart), end: round(seg.aEnd) }
}

// a and b are the closing CREDITS_SCAN_SECONDS (or less) of two episodes;
// aOffset is where a's clip starts in its episode.
export function creditsFrom(a: Uint32Array, b: Uint32Array, aOffset: number): number | null {
  const seg = longestCommon(a, b, CREDITS_MIN)
  if (!seg) return null
  return round(aOffset + seg.aStart)
}

// Chapter titles some releases carry, which beat listening when present.
export function markersFromChapters(
  chapters: { start: number; end: number; title: string }[]
): Markers {
  const result: Markers = { introStart: null, introEnd: null, creditsStart: null }
  for (const c of chapters) {
    const t = c.title.trim().toLowerCase()
    if (result.introStart === null && /^(intro|opening|opening credits|op|theme|opening theme)$/.test(t)) {
      result.introStart = round(c.start)
      result.introEnd = round(c.end)
    } else if (result.creditsStart === null && /^(credits|end credits|ending|ending credits|closing credits|ed|outro)$/.test(t)) {
      result.creditsStart = round(c.start)
    }
  }
  return result
}

function round(seconds: number): number {
  return Math.round(seconds * 10) / 10
}
