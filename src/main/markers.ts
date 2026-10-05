import ffmpegStatic from 'ffmpeg-static'
import createMarkersWorker from './markersWorker?nodeWorker'
import { db } from './db'
import { activeStreamCount, onStreamStarted } from './dashboard'
import { listEpisodes } from './repository'
import type { Markers } from './markersCore'
import type { SeasonJob, SeasonResult } from './markersWorker'

// Skip Intro and Up Next at the credits: every TV season is analysed once
// in the background (markersWorker.ts), a season at a time, never while
// something is playing. Raising VERSION re-analyses everything (after the
// detector improves).

const VERSION = 1
const ffmpegPath = (ffmpegStatic as string).replace('app.asar', 'app.asar.unpacked')
const BUSY_RETRY_MS = 60_000
// Reading the start of every episode is a lot of disk and CPU, so it waits
// until nothing has played for this long, and stops when anything starts.
const IDLE_BEFORE_MS = 10 * 60_000
let lastPlaybackAt = Date.now()

db.exec(`
  CREATE TABLE IF NOT EXISTS episode_markers (
    episode_id INTEGER PRIMARY KEY,
    intro_start REAL,
    intro_end REAL,
    credits_start REAL,
    source TEXT NOT NULL,
    version INTEGER NOT NULL,
    analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

export function getMarkers(episodeId: number): Markers | null {
  const row = db
    .prepare('SELECT intro_start, intro_end, credits_start FROM episode_markers WHERE episode_id = ?')
    .get(episodeId) as { intro_start: number | null; intro_end: number | null; credits_start: number | null } | undefined
  if (!row) return null
  return { introStart: row.intro_start, introEnd: row.intro_end, creditsStart: row.credits_start }
}

function nextPendingSeason(): { showId: number; season: number } | null {
  const row = db
    .prepare(
      `SELECT e.show_id AS showId, e.season_number AS season FROM episodes e
       LEFT JOIN episode_markers m ON m.episode_id = e.id
       WHERE m.episode_id IS NULL OR m.version < ?
       ORDER BY e.show_id, e.season_number LIMIT 1`
    )
    .get(VERSION) as { showId: number; season: number } | undefined
  return row ?? null
}

function save(result: SeasonResult): void {
  const upsert = db.prepare(
    `INSERT INTO episode_markers (episode_id, intro_start, intro_end, credits_start, source, version)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(episode_id) DO UPDATE SET intro_start = excluded.intro_start,
       intro_end = excluded.intro_end, credits_start = excluded.credits_start,
       source = excluded.source, version = excluded.version, analyzed_at = datetime('now')`
  )
  for (const { id, markers, source } of result.markers) {
    upsert.run(id, markers.introStart, markers.introEnd, markers.creditsStart, source, VERSION)
  }
}

class Cancelled extends Error {}

// Playback started: the season being analysed stops now (its ffmpeg is
// killed) and is picked up again once things are quiet.
onStreamStarted(() => {
  lastPlaybackAt = Date.now()
  if (running) worker?.postMessage({ cancel: true })
})

let worker: ReturnType<typeof createMarkersWorker> | null = null
let timer: NodeJS.Timeout | null = null
let running = false

function runSeason(job: SeasonJob): Promise<SeasonResult> {
  if (!worker) {
    worker = createMarkersWorker({})
    worker.unref()
  }
  const w = worker
  return new Promise((resolve, reject) => {
    const done = (msg: { ok: boolean; result?: SeasonResult; error?: string; cancelled?: boolean }): void => {
      w.off('error', fail)
      if (msg.ok) resolve(msg.result!)
      else reject(msg.cancelled ? new Cancelled() : new Error(msg.error))
    }
    const fail = (err: Error): void => {
      w.off('message', done)
      worker = null
      reject(err)
    }
    w.once('message', done)
    w.once('error', fail)
    w.postMessage(job)
  })
}

async function work(): Promise<void> {
  if (running) return
  running = true
  try {
    for (;;) {
      if (activeStreamCount() > 0) lastPlaybackAt = Date.now()
      const quietFor = Date.now() - lastPlaybackAt
      if (quietFor < IDLE_BEFORE_MS) {
        schedule(Math.max(BUSY_RETRY_MS, IDLE_BEFORE_MS - quietFor))
        return
      }
      const pending = nextPendingSeason()
      if (!pending) return
      const episodes = listEpisodes(pending.showId).filter((e) => e.seasonNumber === pending.season)
      const done = new Set(
        (
          db
            .prepare(
              `SELECT episode_id FROM episode_markers WHERE version >= ? AND episode_id IN (${episodes.map(() => '?').join(',') || 'NULL'})`
            )
            .all(VERSION, ...episodes.map((e) => e.id)) as { episode_id: number }[]
        ).map((r) => r.episode_id)
      )
      let result: SeasonResult
      try {
        result = await runSeason({
          ffmpegPath,
          episodes: episodes.map((e) => ({
            id: e.id,
            filePath: e.filePath,
            durationSeconds: e.durationSeconds,
            pending: !done.has(e.id)
          }))
        })
      } catch (err) {
        if (err instanceof Cancelled) {
          schedule(IDLE_BEFORE_MS)
          return
        }
        // A file ffmpeg can't read shouldn't hold up the rest: record the
        // season as analysed with nothing found.
        result = {
          markers: episodes
            .filter((e) => !done.has(e.id))
            .map((e) => ({ id: e.id, markers: { introStart: null, introEnd: null, creditsStart: null }, source: 'failed' }))
        }
      }
      save(result)
    }
  } finally {
    running = false
  }
}

// After a scan, and once at startup: new episodes are analysed when the
// server is idle.
export function analyzeMarkersSoon(delayMs = 30_000): void {
  schedule(delayMs)
}

function schedule(delayMs: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void work()
  }, delayMs)
  timer.unref()
}
