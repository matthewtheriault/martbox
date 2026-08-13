import express from 'express'
import { createReadStream, existsSync, statSync } from 'fs'
import { extname, resolve, sep } from 'path'
import { spawn } from 'child_process'
import { Readable } from 'stream'
// @ts-ignore - no types shipped
import ffmpegStatic from 'ffmpeg-static'
import type { Server } from 'http'
import {
  getEpisode,
  getMovie,
  listProfiles,
  createProfile,
  renameProfile,
  deleteProfile,
  listMovies,
  listShows,
  getShow,
  listEpisodes,
  saveProgress,
  getProgress,
  setWatched,
  getContinueWatching,
  getNextEpisodeToWatch,
  listIptvChannels,
  getIptvChannelStreamUrl,
  getAllActivity
} from './repository'
import { probeFile, canDirectPlay } from './ffprobe'
import type { MediaType } from '../shared/types'

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

// Mirrors the same reads/writes exposed over Electron IPC in ipc.ts, so a
// friend's MartBox install (client mode) can reach this host's catalog and
// watch history over the tailnet instead of its own empty local DB. Thin
// wrappers only — all business logic stays in repository.ts.
function registerMetadataApi(app: express.Express): void {
  const json = express.json()

  app.get('/api/profiles', (_req, res) => res.json(listProfiles()))
  app.post('/api/profiles', json, (req, res) => {
    res.json(createProfile(req.body.name, req.body.avatarId))
  })
  app.patch('/api/profiles/:id', json, (req, res) => {
    renameProfile(parseInt(req.params.id, 10), req.body.name)
    res.json({ ok: true })
  })
  app.delete('/api/profiles/:id', (req, res) => {
    deleteProfile(parseInt(req.params.id, 10))
    res.json({ ok: true })
  })

  app.get('/api/movies', (req, res) => {
    const libraryId = req.query.libraryId ? parseInt(req.query.libraryId as string, 10) : undefined
    res.json(listMovies(libraryId))
  })
  app.get('/api/movies/:id', (req, res) => res.json(getMovie(parseInt(req.params.id, 10))))

  app.get('/api/shows', (req, res) => {
    const libraryId = req.query.libraryId ? parseInt(req.query.libraryId as string, 10) : undefined
    res.json(listShows(libraryId))
  })
  app.get('/api/shows/:id', (req, res) => res.json(getShow(parseInt(req.params.id, 10))))
  app.get('/api/shows/:id/episodes', (req, res) =>
    res.json(listEpisodes(parseInt(req.params.id, 10)))
  )
  app.get('/api/shows/:id/nextEpisode', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    res.json(getNextEpisodeToWatch(profileId, parseInt(req.params.id, 10)))
  })
  app.get('/api/episodes/:id', (req, res) => res.json(getEpisode(parseInt(req.params.id, 10))))

  app.get('/api/progress', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    const mediaType = req.query.mediaType as MediaType
    const mediaId = parseInt(req.query.mediaId as string, 10)
    res.json(getProgress(profileId, mediaType, mediaId))
  })
  app.post('/api/progress', json, (req, res) => {
    const { profileId, mediaType, mediaId, positionSeconds, durationSeconds } = req.body
    saveProgress(profileId, mediaType, mediaId, positionSeconds, durationSeconds)
    res.json({ ok: true })
  })
  app.post('/api/progress/watched', json, (req, res) => {
    const { profileId, mediaType, mediaId, watched } = req.body
    setWatched(profileId, mediaType, mediaId, watched)
    res.json({ ok: true })
  })

  app.get('/api/continueWatching', (req, res) => {
    const profileId = parseInt(req.query.profileId as string, 10)
    res.json(getContinueWatching(profileId))
  })

  app.get('/api/iptv/channels', (_req, res) => res.json(listIptvChannels()))

  app.get('/api/activity', (_req, res) => res.json(getAllActivity()))
}

const PASSTHROUGH_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']

function absolutize(base: string, ref: string): string {
  return new URL(ref.trim(), base).toString()
}

// Rewrites every non-#-prefixed line (segment/sub-playlist URL) plus URI="..."
// attributes inside #EXT-X-KEY/#EXT-X-MEDIA tags (AES-128 key fetches and
// alt audio/subtitle playlists must also transit our proxy — the browser
// has no direct route to the origin IPTV host). Master playlist -> media
// playlist -> segments all flow back through proxyLiveUrl via these
// rewritten URLs, so there's no need to special-case each HLS layer here.
function rewriteManifest(text: string, manifestUrl: string, channelId: string): string {
  const proxied = (abs: string): string => `/live/${channelId}/segment?u=${encodeURIComponent(abs)}`
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (trimmed.startsWith('#EXT-X-KEY') || trimmed.startsWith('#EXT-X-MEDIA')) {
        return trimmed.replace(/URI="([^"]+)"/, (_m, uri) => `URI="${proxied(absolutize(manifestUrl, uri))}"`)
      }
      if (trimmed.startsWith('#')) return line
      return proxied(absolutize(manifestUrl, trimmed))
    })
    .join('\n')
}

async function proxyLiveUrl(
  targetUrl: string,
  channelId: string,
  req: express.Request,
  res: express.Response
): Promise<void> {
  const controller = new AbortController()
  req.on('close', () => controller.abort())

  let upstream: Response
  try {
    upstream = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MartBox/1.0',
        ...(req.headers.range ? { Range: req.headers.range as string } : {})
      }
    })
  } catch {
    res.status(502).end()
    return
  }
  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status || 502).end()
    return
  }

  const urlPath = new URL(targetUrl).pathname.toLowerCase()
  const contentType = upstream.headers.get('content-type') || ''
  const looksLikeManifest = urlPath.endsWith('.m3u8') || contentType.includes('mpegurl')

  if (looksLikeManifest) {
    const text = await upstream.text()
    if (text.trimStart().startsWith('#EXTM3U')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
      res.status(200).send(rewriteManifest(text, targetUrl, channelId))
      return
    }
    res.setHeader('Content-Type', contentType || 'application/octet-stream')
    res.status(200).send(text)
    return
  }

  for (const h of PASSTHROUGH_HEADERS) {
    const v = upstream.headers.get(h)
    if (v) res.setHeader(h, v)
  }
  res.status(upstream.status)
  Readable.fromWeb(upstream.body as any).pipe(res)
}

export function startMediaServer(imageCacheDir: string): Promise<number> {
  const app = express()

  registerMetadataApi(app)

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

  app.get('/live/:channelId', async (req, res) => {
    const streamUrl = getIptvChannelStreamUrl(parseInt(req.params.channelId, 10))
    if (!streamUrl) {
      res.status(404).end()
      return
    }
    await proxyLiveUrl(streamUrl, req.params.channelId, req, res)
  })

  app.get('/live/:channelId/segment', async (req, res) => {
    const target = req.query.u as string
    if (!target || !/^https?:\/\//i.test(target)) {
      res.status(400).end()
      return
    }
    await proxyLiveUrl(target, req.params.channelId, req, res)
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
