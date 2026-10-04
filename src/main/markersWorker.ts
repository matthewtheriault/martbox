import { parentPort } from 'worker_threads'
import { spawn } from 'child_process'
import { constants, setPriority } from 'os'
import { probeChapters } from './ffprobe'
import {
  CREDITS_SCAN_SECONDS,
  INTRO_SCAN_SECONDS,
  SAMPLE_RATE,
  creditsFrom,
  fingerprint,
  introFrom,
  markersFromChapters,
  type Markers
} from './markersCore'

// Runs off the main thread (markers.ts): decoding and fingerprinting a
// season takes a minute or so of CPU, which would otherwise stall the
// server.

export interface SeasonJob {
  ffmpegPath: string
  episodes: { id: number; filePath: string; durationSeconds: number | null; pending: boolean }[]
}

export interface SeasonResult {
  markers: { id: number; markers: Markers; source: string }[]
}

interface Clip {
  fp: Uint32Array
  offset: number
}

function decode(ffmpegPath: string, filePath: string, start: number, seconds: number): Promise<Int16Array> {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-nostdin']
    if (start > 0) args.push('-ss', String(start))
    args.push('-t', String(seconds), '-i', filePath, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-')
    const proc = spawn(ffmpegPath, args)
    try {
      if (proc.pid) setPriority(proc.pid, constants.priority.PRIORITY_LOW)
    } catch {
      /* not allowed on this system: it just runs at normal priority */
    }
    const chunks: Buffer[] = []
    proc.stdout.on('data', (c: Buffer) => chunks.push(c))
    proc.on('error', () => resolve(new Int16Array(0)))
    proc.on('close', () => {
      const buf = Buffer.concat(chunks)
      const bytes = buf.length - (buf.length % 2)
      resolve(new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytes)))
    })
  })
}

export async function analyzeSeason(job: SeasonJob): Promise<SeasonResult> {
  const heads = new Map<number, Clip>()
  const tails = new Map<number, Clip>()
  const head = async (i: number): Promise<Clip> => {
    const ep = job.episodes[i]
    let clip = heads.get(ep.id)
    if (!clip) {
      const scan = Math.min(INTRO_SCAN_SECONDS, ep.durationSeconds ? ep.durationSeconds * 0.4 : INTRO_SCAN_SECONDS)
      clip = { fp: fingerprint(await decode(job.ffmpegPath, ep.filePath, 0, scan)), offset: 0 }
      heads.set(ep.id, clip)
    }
    return clip
  }
  const tail = async (i: number): Promise<Clip | null> => {
    const ep = job.episodes[i]
    if (!ep.durationSeconds) return null
    let clip = tails.get(ep.id)
    if (!clip) {
      const scan = Math.min(CREDITS_SCAN_SECONDS, ep.durationSeconds * 0.3)
      const offset = ep.durationSeconds - scan
      clip = { fp: fingerprint(await decode(job.ffmpegPath, ep.filePath, offset, scan)), offset }
      tails.set(ep.id, clip)
    }
    return clip
  }

  const result: SeasonResult = { markers: [] }
  for (let i = 0; i < job.episodes.length; i++) {
    const ep = job.episodes[i]
    if (!ep.pending) continue
    const markers = markersFromChapters(await probeChapters(ep.filePath))
    const fromChapters = markers.introStart !== null || markers.creditsStart !== null
    let listened = false
    // The nearest episodes first: a theme changes between seasons more
    // than between neighbours.
    const partners = [i + 1, i - 1, i + 2, i - 2].filter((j) => j >= 0 && j < job.episodes.length)
    if (markers.introStart === null) {
      for (const j of partners.slice(0, 3)) {
        const intro = introFrom((await head(i)).fp, (await head(j)).fp)
        listened = true
        if (intro) {
          markers.introStart = intro.start
          markers.introEnd = intro.end
          break
        }
      }
    }
    if (markers.creditsStart === null) {
      const mine = await tail(i)
      for (const j of mine ? partners.slice(0, 3) : []) {
        const theirs = await tail(j)
        if (!theirs) continue
        const start = creditsFrom(mine!.fp, theirs.fp, mine!.offset)
        listened = true
        // Credits are at the end: the shared stretch has to be in the
        // last half and after the intro.
        if (start !== null && ep.durationSeconds && start > ep.durationSeconds * 0.5 && start > (markers.introEnd ?? 0)) {
          markers.creditsStart = start
          break
        }
      }
    }
    result.markers.push({
      id: ep.id,
      markers,
      source: fromChapters ? (listened ? 'chapters+audio' : 'chapters') : 'audio'
    })
  }
  return result
}

parentPort?.on('message', async (job: SeasonJob) => {
  try {
    parentPort!.postMessage({ ok: true, result: await analyzeSeason(job) })
  } catch (err) {
    parentPort!.postMessage({ ok: false, error: String(err) })
  }
})
