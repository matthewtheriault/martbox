import { db } from './db'
import { probeFile } from './ffprobe'
import { getEpisode, getMovie, getShow } from './repository'
import { shuffled, slotAt, slotsBetween, type ScheduleItem } from './channelSchedule'
import type {
  Channel,
  ChannelConfig,
  ChannelGuide,
  ChannelNow,
  ChannelProgram,
  ChannelSource
} from '../shared/types'

// Live Channels: always-on channels made from media already in the library,
// like ErsatzTV. A channel is a list of items played back to back forever
// from a fixed start (see channelSchedule.ts), so what's on is worked out
// from the clock; nothing runs while nobody watches. Tuning in plays the
// current item from the right point through the normal playback paths
// (direct play / remux / transcode), capped at the channel's quality.
//
// Each item's real length is measured once when the channel is built (a
// movie's TMDB runtime is rounded to the minute and would make the schedule
// drift) and stored with the channel. Channels are rebuilt when edited, at
// startup and after library scans, keeping their start time, so new
// episodes join without resetting what's on.

db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number INTEGER NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    -- JSON [[mediaType, mediaId, seconds], ...]: the built play order.
    items TEXT NOT NULL DEFAULT '[]',
    epoch INTEGER NOT NULL,
    seed INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

// A channel this long would take ages to build and nobody would get through
// it; plenty for "every episode of three long-running shows".
const MAX_ITEMS = 5000

interface ChannelRow {
  id: number
  number: number
  name: string
  config: string
  items: string
  epoch: number
  seed: number
}

function parseItems(json: string): ScheduleItem[] {
  try {
    const parsed = JSON.parse(json) as [string, number, number][]
    return parsed.map(([mediaType, mediaId, seconds]) => ({
      mediaType: mediaType === 'movie' ? 'movie' : 'episode',
      mediaId,
      seconds
    }))
  } catch {
    return []
  }
}

function toChannel(row: ChannelRow, items: ScheduleItem[]): Channel {
  const config = JSON.parse(row.config) as ChannelConfig
  return {
    ...config,
    id: row.id,
    number: row.number,
    name: row.name,
    itemCount: items.length,
    cycleSeconds: items.reduce((sum, item) => sum + item.seconds, 0)
  }
}

function rows(): ChannelRow[] {
  return db.prepare('SELECT * FROM channels ORDER BY number, id').all() as ChannelRow[]
}

export function listChannels(): Channel[] {
  return rows().map((row) => toChannel(row, parseItems(row.items)))
}

// --- Building a channel's play order ---

interface EpisodeRow {
  id: number
  file_path: string
  duration_seconds: number | null
}

interface MovieRow {
  id: number
  file_path: string
  year: number | null
  runtime_minutes: number | null
  genres: string | null
  collection_id: number | null
}

async function lengthOf(filePath: string, known: number | null): Promise<number | null> {
  if (known && known > 0) return known
  const probed = (await probeFile(filePath)).durationSeconds
  return probed && probed > 0 ? probed : null
}

async function itemsFor(source: ChannelSource): Promise<ScheduleItem[]> {
  const items: ScheduleItem[] = []
  if (source.kind === 'show') {
    // Specials (season 0) are left out; they rarely make sense in a run.
    const episodes = db
      .prepare(
        `SELECT id, file_path, duration_seconds FROM episodes
         WHERE show_id = ? AND season_number > 0 ORDER BY season_number, episode_number`
      )
      .all(source.showId) as EpisodeRow[]
    for (const ep of episodes) {
      const seconds = await lengthOf(ep.file_path, ep.duration_seconds)
      if (seconds) items.push({ mediaType: 'episode', mediaId: ep.id, seconds })
    }
    return items
  }
  const movies = (
    db
      .prepare(
        `SELECT id, file_path, year, runtime_minutes, genres, collection_id FROM movies
         ORDER BY year, sort_title`
      )
      .all() as MovieRow[]
  ).filter((m) => {
    if (source.collectionId && m.collection_id !== source.collectionId) return false
    if (source.decade && !(m.year && m.year >= source.decade && m.year < source.decade + 10)) {
      return false
    }
    if (source.genre) {
      let genres: string[] = []
      try {
        genres = JSON.parse(m.genres ?? '[]')
      } catch {
        genres = []
      }
      if (!genres.includes(source.genre)) return false
    }
    return true
  })
  for (const movie of movies) {
    // The file's real length; the TMDB runtime is only a fallback.
    const probed = (await probeFile(movie.file_path)).durationSeconds
    const seconds =
      probed && probed > 0 ? probed : movie.runtime_minutes ? movie.runtime_minutes * 60 : null
    if (seconds) items.push({ mediaType: 'movie', mediaId: movie.id, seconds })
  }
  return items
}

async function buildItems(config: ChannelConfig, seed: number): Promise<ScheduleItem[]> {
  const seen = new Set<string>()
  let items: ScheduleItem[] = []
  for (const source of config.sources) {
    for (const item of await itemsFor(source)) {
      const key = `${item.mediaType}:${item.mediaId}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
  }
  if (config.order === 'shuffle') items = shuffled(items, seed)
  return items.slice(0, MAX_ITEMS)
}

function serialiseItems(items: ScheduleItem[]): string {
  return JSON.stringify(
    items.map((i) => [i.mediaType, i.mediaId, Math.round(i.seconds * 1000) / 1000])
  )
}

function normaliseConfig(config: ChannelConfig): ChannelConfig {
  return {
    name: config.name.trim().slice(0, 60) || 'Channel',
    number: Number.isInteger(config.number) && config.number > 0 ? config.number : 1,
    sources: config.sources,
    order: config.order === 'inOrder' ? 'inOrder' : 'shuffle',
    maxQuality: ['1080', '720', '480'].includes(config.maxQuality) ? config.maxQuality : 'auto'
  }
}

// Creates (id null) or updates a channel. Editing keeps its start time, so
// it carries on from roughly where it was.
export async function saveChannel(id: number | null, input: ChannelConfig): Promise<Channel> {
  const config = normaliseConfig(input)
  const existing =
    id === null
      ? undefined
      : (db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined)
  const seed = existing?.seed ?? Math.floor(Math.random() * 2 ** 31)
  const items = await buildItems(config, seed)
  let rowId: number
  if (existing) {
    db.prepare(
      `UPDATE channels SET number = ?, name = ?, config = ?, items = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(config.number, config.name, JSON.stringify(config), serialiseItems(items), existing.id)
    rowId = existing.id
  } else {
    const result = db
      .prepare(
        'INSERT INTO channels (number, name, config, items, epoch, seed) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        config.number,
        config.name,
        JSON.stringify(config),
        serialiseItems(items),
        Date.now(),
        seed
      )
    rowId = Number(result.lastInsertRowid)
  }
  const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(rowId) as ChannelRow
  return toChannel(row, items)
}

export function deleteChannel(id: number): void {
  db.prepare('DELETE FROM channels WHERE id = ?').run(id)
}

let rebuilding: Promise<void> | null = null

// New episodes and movies join their channels (startup and after scans).
export function rebuildAllChannels(): Promise<void> {
  if (rebuilding) return rebuilding
  rebuilding = (async () => {
    for (const row of rows()) {
      try {
        const config = JSON.parse(row.config) as ChannelConfig
        const items = await buildItems(config, row.seed)
        db.prepare('UPDATE channels SET items = ? WHERE id = ?').run(serialiseItems(items), row.id)
      } catch {
        /* keep the old schedule */
      }
    }
  })().finally(() => {
    rebuilding = null
  })
  return rebuilding
}

// --- What's on ---

function program(item: ScheduleItem, start: number, end: number): ChannelProgram | null {
  if (item.mediaType === 'movie') {
    const movie = getMovie(item.mediaId)
    if (!movie) return null
    return {
      mediaType: 'movie',
      mediaId: item.mediaId,
      title: movie.title,
      subtitle: movie.year ? String(movie.year) : '',
      posterPath: movie.posterPath,
      start,
      end
    }
  }
  const episode = getEpisode(item.mediaId)
  if (!episode) return null
  const show = getShow(episode.showId)
  return {
    mediaType: 'episode',
    mediaId: item.mediaId,
    title: show?.title ?? episode.title,
    subtitle: `S${episode.seasonNumber} · E${episode.episodeNumber} · ${episode.title}`,
    posterPath: show?.posterPath ?? null,
    start,
    end
  }
}

export function channelNow(id: number, t = Date.now()): ChannelNow | null {
  const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined
  if (!row) return null
  const items = parseItems(row.items)
  const slot = slotAt(items, row.epoch, t)
  if (!slot) return null
  const now = program(items[slot.index], slot.start, slot.end)
  if (!now) return null
  const nextIndex = (slot.index + 1) % items.length
  const nextEnd = slot.end + items[nextIndex].seconds * 1000
  return {
    channel: toChannel(row, items),
    program: now,
    offsetSeconds: Math.max(0, (t - slot.start) / 1000),
    next: program(items[nextIndex], slot.end, nextEnd)
  }
}

export function channelGuide(from: number, to: number): ChannelGuide {
  return {
    from,
    to,
    channels: rows().map((row) => {
      const items = parseItems(row.items)
      const programs = slotsBetween(items, row.epoch, from, to)
        .map((slot) => program(items[slot.index], slot.start, slot.end))
        .filter((p): p is ChannelProgram => p !== null)
      return { channel: toChannel(row, items), programs }
    })
  }
}
