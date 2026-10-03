import { execFile } from 'child_process'
import { promisify } from 'util'
// @ts-ignore - no types shipped
import ffprobeStatic from 'ffprobe-static'

const execFileAsync = promisify(execFile)

export interface MediaProbe {
  container: string
  videoCodec: string | null
  audioCodec: string | null
  durationSeconds: number | null
  // The rest feeds the direct-play decision (playback.ts). All null when
  // ffprobe can't tell.
  width: number | null
  height: number | null
  // Whole-file average, video and audio together.
  bitRateKbps: number | null
  // e.g. 'hvc1' / 'hev1' / 'avc1' — Apple players only take HEVC tagged hvc1.
  videoCodecTag: string | null
  // 8 or 10 (from the pixel format).
  bitDepth: number | null
  hdr: 'hdr10' | 'hlg' | null
  dolbyVisionProfile: number | null
  // ffmpeg starts a seek a little early in files with B-frames; remuxing
  // has to correct for it (see hls.ts).
  hasBFrames: boolean
  // Timestamp of the file's first frame — usually 0, sometimes a few ms.
  startSeconds: number
  audioChannels: number | null
}

const EMPTY_PROBE: MediaProbe = {
  container: '',
  videoCodec: null,
  audioCodec: null,
  durationSeconds: null,
  width: null,
  height: null,
  bitRateKbps: null,
  videoCodecTag: null,
  bitDepth: null,
  hdr: null,
  dolbyVisionProfile: null,
  hasBFrames: false,
  startSeconds: 0,
  audioChannels: null
}

function positiveNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

// Parses ffprobe's -show_format -show_streams JSON.
export function parseProbe(data: any): MediaProbe {
  const videoStream = data.streams?.find(
    (s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic
  )
  const audioStream = data.streams?.find((s: any) => s.codec_type === 'audio')
  const pixFmt: string = videoStream?.pix_fmt ?? ''
  const transfer: string = videoStream?.color_transfer ?? ''
  const dovi = videoStream?.side_data_list?.find((d: any) => d.dv_profile !== undefined)
  const bitRate = positiveNumber(data.format?.bit_rate)
  return {
    container: (data.format?.format_name || '').split(',')[0] || '',
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    durationSeconds: data.format?.duration ? parseFloat(data.format.duration) : null,
    width: positiveNumber(videoStream?.width),
    height: positiveNumber(videoStream?.height),
    bitRateKbps: bitRate ? Math.round(bitRate / 1000) : null,
    videoCodecTag:
      videoStream?.codec_tag_string && videoStream.codec_tag_string !== '[0][0][0][0]'
        ? videoStream.codec_tag_string
        : null,
    bitDepth: videoStream ? (/1[02]le$|1[02]be$|p010/.test(pixFmt) ? 10 : 8) : null,
    hdr: transfer === 'smpte2084' ? 'hdr10' : transfer === 'arib-std-b67' ? 'hlg' : null,
    dolbyVisionProfile: dovi ? Number(dovi.dv_profile) : null,
    hasBFrames: Number(videoStream?.has_b_frames ?? 0) > 0,
    startSeconds: Number.isFinite(parseFloat(data.format?.start_time))
      ? parseFloat(data.format.start_time)
      : 0,
    audioChannels: positiveNumber(audioStream?.channels)
  }
}

const probeCache = new Map<string, MediaProbe>()

export async function probeFile(filePath: string): Promise<MediaProbe> {
  const cached = probeCache.get(filePath)
  if (cached) return cached

  try {
    const { stdout } = await execFileAsync(ffprobeStatic.path, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath
    ])
    const probe = parseProbe(JSON.parse(stdout))
    probeCache.set(filePath, probe)
    return probe
  } catch {
    return { ...EMPTY_PROBE }
  }
}

export function canDirectPlay(probe: MediaProbe, extension: string): boolean {
  const ext = extension.toLowerCase()
  const containerOk = ext === '.mp4' || ext === '.m4v' || ext === '.mov'
  const videoOk = probe.videoCodec === 'h264'
  const audioOk = probe.audioCodec === 'aac' || probe.audioCodec === 'mp3' || !probe.audioCodec
  return containerOk && videoOk && audioOk
}
