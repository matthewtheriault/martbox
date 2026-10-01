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
    const data = JSON.parse(stdout)
    const videoStream = data.streams?.find((s: any) => s.codec_type === 'video')
    const audioStream = data.streams?.find((s: any) => s.codec_type === 'audio')
    const probe: MediaProbe = {
      container: (data.format?.format_name || '').split(',')[0] || '',
      videoCodec: videoStream?.codec_name ?? null,
      audioCodec: audioStream?.codec_name ?? null,
      durationSeconds: data.format?.duration ? parseFloat(data.format.duration) : null
    }
    probeCache.set(filePath, probe)
    return probe
  } catch {
    return { container: '', videoCodec: null, audioCodec: null, durationSeconds: null }
  }
}

export function canDirectPlay(probe: MediaProbe, extension: string): boolean {
  const ext = extension.toLowerCase()
  const containerOk = ext === '.mp4' || ext === '.m4v' || ext === '.mov'
  const videoOk = probe.videoCodec === 'h264'
  const audioOk = probe.audioCodec === 'aac' || probe.audioCodec === 'mp3' || !probe.audioCodec
  return containerOk && videoOk && audioOk
}
