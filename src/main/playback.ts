import type { MediaProbe } from './ffprobe'

// How a file reaches a player, best first:
//   direct    — the original file, byte for byte (/stream with ranges).
//   remux     — the original video, untouched, repackaged into HLS for
//               players that can't open the container (MKV on Apple). The
//               audio is copied too when the player can decode it.
//   transcode — re-encoded HLS at a size and bitrate that fits.
// The original is used whenever the device can decode it and its
// connection can carry it; otherwise the server converts it down.

export type PlaybackMethod = 'direct' | 'remux' | 'transcode'

// What the player says it can decode.
export interface ClientCaps {
  videoCodecs: string[]
  // Highest video height it decodes smoothly (2160 for 4K-capable devices).
  maxHeight: number
  // Can decode 10-bit HEVC (HDR10/HLG files are 10-bit).
  hevc10Bit: boolean
  // Dolby Vision profiles 5 and 8 (single-layer).
  dolbyVision: boolean
  audioCodecs: string[]
}

export type QualityChoice = 'auto' | 'original' | '1080' | '720' | '480'

export interface TranscodeRung {
  height: number
  // Average video bitrate; the encoder's peak is a little above.
  kbps: number
}

export const TRANSCODE_LADDER: TranscodeRung[] = [
  { height: 1080, kbps: 8000 },
  { height: 720, kbps: 4000 },
  { height: 480, kbps: 1500 }
]

// A stream needs about half again its average rate in spare connection to
// ride out its own peaks and the connection's dips.
export const BANDWIDTH_HEADROOM = 1.5

export interface PlaybackDecision {
  method: PlaybackMethod
  // Remux and transcode: whether the original audio is kept or converted.
  audio?: 'copy' | 'convert'
  // Only for transcode.
  rung?: TranscodeRung
  // One line for the dashboard and logs.
  reason: string
}

export interface PlaybackInput {
  probe: MediaProbe
  extension: string
  caps: ClientCaps
  // Measured speed between the server and this device; null if unknown
  // (unknown never blocks the original).
  bandwidthKbps: number | null
  quality: QualityChoice
  // The MKV's keyframe index was readable — needed to remux.
  canRemux: boolean
  // Methods that already failed on this device for this file.
  avoid: PlaybackMethod[]
}

const DIRECT_CONTAINERS = new Set(['.mp4', '.m4v', '.mov'])
const HDR_TRANSFERS = new Set(['hdr10', 'hlg'])

function videoDecodable(probe: MediaProbe, caps: ClientCaps): string | null {
  const codec = probe.videoCodec
  if (!codec) return 'no video stream found'
  if (!caps.videoCodecs.includes(codec)) return `${codec} video isn't supported by this device`
  if (probe.height && probe.height > caps.maxHeight) {
    return `${probe.height}p is above this device's ${caps.maxHeight}p limit`
  }
  // 10-bit H.264 (Hi10P) has no hardware decoder anywhere.
  if (codec === 'h264' && (probe.bitDepth ?? 8) > 8) return "10-bit H.264 isn't widely supported"
  if (codec === 'hevc' && (probe.bitDepth ?? 8) > 8 && !caps.hevc10Bit) {
    return "this device can't decode 10-bit HEVC"
  }
  // Profile 7 (Blu-ray dual layer) plays nowhere but dedicated players;
  // 5 has no HDR10 fallback, so it needs real Dolby Vision support.
  const dv = probe.dolbyVisionProfile
  if (dv === 7) return 'Dolby Vision profile 7 needs converting'
  if (dv === 5 && !caps.dolbyVision) return "this device doesn't support Dolby Vision"
  return null
}

function audioDecodable(probe: MediaProbe, caps: ClientCaps): boolean {
  return !probe.audioCodec || caps.audioCodecs.includes(probe.audioCodec)
}

// Apple players reject HEVC in MP4 unless it's tagged hvc1.
function directTagOk(probe: MediaProbe): boolean {
  return probe.videoCodec !== 'hevc' || probe.videoCodecTag === 'hvc1'
}

function fitRung(bandwidthKbps: number | null, sourceHeight: number | null): TranscodeRung {
  const fits = TRANSCODE_LADDER.filter(
    (r) => bandwidthKbps === null || r.kbps * BANDWIDTH_HEADROOM <= bandwidthKbps
  )
  const rung = fits[0] ?? TRANSCODE_LADDER[TRANSCODE_LADDER.length - 1]
  // Never "convert up": a 720p source stays 720p at most.
  if (sourceHeight) {
    const notAbove = TRANSCODE_LADDER.find((r) => r.height <= Math.max(sourceHeight, 480))
    if (notAbove && notAbove.height < rung.height) return notAbove
  }
  return rung
}

// Only the picture is converted: the original audio is kept whenever the
// device plays it (it's the audio's own quality, and costs nothing).
function transcode(input: PlaybackInput, why: string, rung?: TranscodeRung): PlaybackDecision {
  const chosen = rung ?? fitRung(input.bandwidthKbps, input.probe.height)
  return {
    method: 'transcode',
    rung: chosen,
    audio: audioDecodable(input.probe, input.caps) ? 'copy' : 'convert',
    reason: `Converting to ${chosen.height}p: ${why}`
  }
}

export function decidePlayback(input: PlaybackInput): PlaybackDecision {
  const { probe, caps, bandwidthKbps, quality, avoid } = input

  // A chosen size converts, unless the original is already no bigger.
  if (quality === '1080' || quality === '720' || quality === '480') {
    const rung = TRANSCODE_LADDER.find((r) => r.height === parseInt(quality, 10))!
    const small = probe.height !== null && probe.height <= rung.height
    const light = probe.bitRateKbps !== null && probe.bitRateKbps <= rung.kbps * 1.25
    if (!(small && light)) return transcode(input, `${quality}p chosen in settings`, rung)
  }

  const videoProblem = videoDecodable(probe, caps)
  if (videoProblem) return transcode(input, videoProblem)

  if (quality === 'auto' && bandwidthKbps !== null && probe.bitRateKbps !== null) {
    if (probe.bitRateKbps * BANDWIDTH_HEADROOM > bandwidthKbps) {
      return transcode(
        input,
        `the original (${Math.round(probe.bitRateKbps / 1000)} Mbps) needs more than this ` +
          `connection's ${Math.round(bandwidthKbps / 1000)} Mbps`
      )
    }
  }

  const audioOk = audioDecodable(probe, caps)
  const hdr = probe.hdr && HDR_TRANSFERS.has(probe.hdr) ? ` ${probe.hdr.toUpperCase()}` : ''
  const label = `${probe.height ? `${probe.height}p ` : ''}${probe.videoCodec?.toUpperCase()}${hdr}`

  if (
    !avoid.includes('direct') &&
    DIRECT_CONTAINERS.has(input.extension.toLowerCase()) &&
    audioOk &&
    directTagOk(probe)
  ) {
    return { method: 'direct', reason: `Direct play: original ${label}` }
  }
  if (!avoid.includes('remux') && input.canRemux) {
    return {
      method: 'remux',
      audio: audioOk ? 'copy' : 'convert',
      reason: audioOk
        ? `Direct stream: original ${label}, repackaged`
        : `Direct stream: original ${label}; ${probe.audioCodec?.toUpperCase()} audio converted`
    }
  }
  return transcode(
    input,
    avoid.length > 0 ? "the original didn't play on this device" : "this file can't be repackaged"
  )
}

// HDR10 / HLG → normal (SDR, BT.709) colours for anything we re-encode to
// H.264: without it, HDR video converted for a phone, a Fire TV or a slow
// connection comes out grey and washed out. Linearise, convert the BT.2020
// colours to BT.709, then compress the brightness with the Mobius curve —
// it keeps mid-tones as they were and only rolls off the bright highlights
// HDR adds (it matched the original most closely in a side-by-side of
// hable / mobius / reinhard). zscale (libzimg) is in the bundled ffmpeg on
// both Windows and macOS. Dolby Vision profile 8 carries an HDR10/HLG base
// layer, so it's handled the same way.
export function toneMapFilters(probe: MediaProbe): string[] {
  if (probe.hdr !== 'hdr10' && probe.hdr !== 'hlg') return []
  const transfer = probe.hdr === 'hlg' ? 'arib-std-b67' : 'smpte2084'
  return [
    `zscale=tin=${transfer}:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100`,
    'format=gbrpf32le',
    'zscale=p=bt709',
    'tonemap=tonemap=mobius:desat=0',
    'zscale=t=bt709:m=bt709:r=tv'
  ]
}

// Tags the output as SDR so players don't treat it as HDR.
export const SDR_COLOR_TAGS = [
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-colorspace',
  'bt709'
]
