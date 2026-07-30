import express from 'express'
import { createReadStream, existsSync, statSync } from 'fs'
import { extname, resolve, sep } from 'path'
import { spawn } from 'child_process'
// @ts-ignore - no types shipped
import ffmpegStatic from 'ffmpeg-static'
import type { Server } from 'http'
import { getEpisode, getMovie } from './repository'
import { probeFile, canDirectPlay } from './ffprobe'

let server: Server | null = null
let boundPort = 0

function resolveMediaPath(mediaType: string, id: number): string | null {
  if (mediaType === 'movie') return getMovie(id)?.filePath ?? null
  if (mediaType === 'episode') return getEpisode(id)?.filePath ?? null
  return null
}

function streamDirect(req: express.Request, res: express.Response, filePath: string): void {
  const stat = statSync(filePath)
  const range = req.headers.range
  const contentType = extname(filePath).toLowerCase() === '.mp4' ? 'video/mp4' : 'video/quicktime'

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

function streamTranscode(
  req: express.Request,
  res: express.Response,
  filePath: string,
  videoCodec: string | null
): void {
  const startSeconds = parseFloat((req.query.t as string) || '0') || 0

  const args = [
    '-ss',
    String(startSeconds),
    '-i',
    filePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    ...(videoCodec === 'h264' ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']),
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    '-f',
    'mp4',
    'pipe:1'
  ]

  const ff = spawn(ffmpegStatic as string, args)
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'none' })
  ff.stdout.pipe(res)
  ff.stderr.on('data', () => {})
  const cleanup = (): void => {
    if (!ff.killed) ff.kill('SIGKILL')
  }
  req.on('close', cleanup)
  ff.on('error', cleanup)
}

export function startMediaServer(imageCacheDir: string): Promise<number> {
  const app = express()

  app.get('/stream/:mediaType/:id', async (req, res) => {
    const { mediaType, id } = req.params
    const filePath = resolveMediaPath(mediaType, parseInt(id, 10))
    if (!filePath || !existsSync(filePath)) {
      res.status(404).end()
      return
    }
    const probe = await probeFile(filePath)
    if (canDirectPlay(probe, extname(filePath))) {
      streamDirect(req, res, filePath)
    } else {
      streamTranscode(req, res, filePath, probe.videoCodec)
    }
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

  app.get('/image', (req, res) => {
    const raw = req.query.path as string
    if (!raw) {
      res.status(400).end()
      return
    }
    const resolved = resolve(raw)
    if (!resolved.startsWith(resolve(imageCacheDir) + sep)) {
      res.status(403).end()
      return
    }
    if (!existsSync(resolved)) {
      res.status(404).end()
      return
    }
    res.sendFile(resolved)
  })

  return new Promise((resolvePort) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      boundPort = typeof address === 'object' && address ? address.port : 0
      resolvePort(boundPort)
    })
  })
}

export function getMediaServerPort(): number {
  return boundPort
}

export function stopMediaServer(): void {
  server?.close()
}
