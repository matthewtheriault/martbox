import { execFile } from 'child_process'
import { promisify } from 'util'
// @ts-ignore - no types shipped
import ffprobeStatic from 'ffprobe-static'

const execFileAsync = promisify(execFile)

// The real file in a packaged app (asarUnpack): spelled out, because the
// intro detector calls this from a worker thread, where Electron doesn't
// redirect asar paths for us.
const ffprobePath = (ffprobeStatic.path as string).replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')

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
  // How far the first frame is shown after the stream starts when the
  // video has B-frames (frames of delay × frame length).
  videoDelaySeconds: number
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
  videoDelaySeconds: 0,
  startSeconds: 0,
  audioChannels: null
}

function positiveNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

function frameDelay(stream: any): number {
  const frames = Number(stream?.has_b_frames ?? 0)
  const [num, den] = String(stream?.avg_frame_rate || stream?.r_frame_rate || '0/1').split('/').map(Number)
  const fps = den ? num / den : 0
  return frames > 0 && fps > 0 ? frames / fps : 0
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
    videoDelaySeconds: frameDelay(videoStream),
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
    const { stdout } = await execFileAsync(ffprobePath, [
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

export interface Chapter {
  start: number
  end: number
  title: string
}

export async function probeChapters(filePath: string): Promise<Chapter[]> {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_chapters',
      filePath
    ])
    const data = JSON.parse(stdout)
    return (data.chapters ?? []).map((c: any) => ({
      start: parseFloat(c.start_time),
      end: parseFloat(c.end_time),
      title: String(c.tags?.title ?? '')
    }))
  } catch {
    return []
  }
}

// The video keyframe at or before `seconds` (counted from the file's start,
// as players count). Copied (not re-encoded) video can only start on a
// keyframe, so a stream that starts anywhere else has its video begin
// earlier than its audio — and Chromium then plays them out of step. Null
// when ffprobe can't tell.
export async function keyframeAtOrBefore(
  filePath: string,
  seconds: number,
  fileStartSeconds: number,
  // A skip forward from here: if the keyframe before `seconds` isn't past
  // it, the first keyframe after it instead (or +10 could go nowhere).
  after?: number
): Promise<number | null> {
  if (seconds <= 0) return 0
  // Keyframes are rarely more than ~10 s apart; 60 s back covers odd files.
  const from = Math.max(0, seconds - 60) + fileStartSeconds
  const to = seconds + fileStartSeconds + (after === undefined ? 0.5 : 30)
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-skip_frame', 'nokey',
        '-show_entries', 'frame=pts_time,best_effort_timestamp_time',
        '-of', 'csv=p=0',
        '-read_intervals', `${from}%${to}`,
        filePath
      ],
      { maxBuffer: 4 * 1024 * 1024 }
    )
    let best: number | null = null
    let next: number | null = null
    for (const line of stdout.split('\n')) {
      const t = line
        .split(',')
        .map((x) => parseFloat(x))
        .find((x) => Number.isFinite(x))
      if (t === undefined) continue
      const rel = t - fileStartSeconds
      if (rel <= seconds + 0.0005 && (best === null || rel > best)) best = rel
      if (after !== undefined && rel > after + 0.5 && (next === null || rel < next)) next = rel
    }
    if (after !== undefined && (best === null || best <= after + 0.5) && next !== null) return next
    return best === null ? null : Math.max(0, best)
  } catch {
    return null
  }
}
