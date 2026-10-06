import { spawn } from 'child_process'
import { statSync } from 'fs'
import ffmpegStatic from 'ffmpeg-static'
import { pickArtColor } from './artColorCore'

// The colour of a piece of artwork (Phase 8), for tinting its page: a
// 24×24 thumbnail from ffmpeg, then artColorCore picks the colour. Kept per
// file (and its change time), so each image is read once.

const ffmpegPath = (ffmpegStatic as string).replace('app.asar', 'app.asar.unpacked')
const SIDE = 24
const cache = new Map<string, string | null>()
const running = new Map<string, Promise<string | null>>()

function thumbnail(file: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const p = spawn(ffmpegPath, ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${SIDE}:${SIDE}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    p.stdout.on('data', (c: Buffer) => chunks.push(c))
    p.on('error', () => resolve(null))
    p.on('close', (code) => {
      const out = Buffer.concat(chunks)
      resolve(code === 0 && out.length === SIDE * SIDE * 3 ? out : null)
    })
  })
}

export function artColor(file: string): Promise<string | null> {
  let key: string
  try {
    key = `${file}|${statSync(file).mtimeMs}`
  } catch {
    return Promise.resolve(null)
  }
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null)
  const job = running.get(key)
  if (job) return job
  const next = thumbnail(file)
    .then((rgb) => (rgb ? pickArtColor(rgb) : null))
    .then((color) => {
      cache.set(key, color)
      return color
    })
    .finally(() => running.delete(key))
  running.set(key, next)
  return next
}
