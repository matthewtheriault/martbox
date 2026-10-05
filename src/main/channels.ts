import { db } from './db'
import { probeFile } from './ffprobe'
import { genresFromDb } from './genres'
import { getEpisode, getMovie, getShow } from './repository'
import {
  programsBetween,
  shuffled,
  type ScheduleItem,
  type TimeBlock
} from './channelSchedule'
import type {
  Channel,
  ChannelBlock,
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

// Time blocks' play orders, built like items: JSON [[[mediaType, mediaId,
// seconds], ...], ...], one list per block in config order.
{
  const cols = db.prepare('PRAGMA table_info(channels)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'block_items')) {
    db.exec("ALTER TABLE channels ADD COLUMN block_items TEXT NOT NULL DEFAULT '[]'")
  }
}

// A channel this long would take ages to build and nobody would get through
// it; plenty for "every episode of three long-running shows".
const MAX_ITEMS = 5000

interface ChannelRow {
  id: number
  number: number
  name: string
  config: string
  items: string
  block_items: string
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
    if (source.genre && !genresFromDb(m.genres).includes(source.genre)) return false
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

async function collect(sources: ChannelSource[]): Promise<ScheduleItem[]> {
  const seen = new Set<string>()
  const items: ScheduleItem[] = []
  for (const source of sources) {
    for (const item of await itemsFor(source)) {
      const key = `${item.mediaType}:${item.mediaId}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
  }
  return items
}

// A lineup's play order, with one filler item (in its own shuffled order)
// after each program when the channel has filler.
async function buildLineup(
  sources: ChannelSource[],
  order: ChannelConfig['order'],
  filler: ScheduleItem[],
  seed: number
): Promise<ScheduleItem[]> {
  let items = await collect(sources)
  if (order === 'shuffle') items = shuffled(items, seed)
  items = items.slice(0, MAX_ITEMS)
  if (filler.length === 0) return items
  const fillerOrder = shuffled(filler, seed + 1)
  return items.flatMap((item, i) => [item, fillerOrder[i % fillerOrder.length]])
}

async function buildItems(
  config: ChannelConfig,
  seed: number
): Promise<{ items: ScheduleItem[]; blockItems: ScheduleItem[][] }> {
  const filler = await collect(config.filler ?? [])
  const items = await buildLineup(config.sources, config.order, filler, seed)
  const blockItems: ScheduleItem[][] = []
  for (const [i, block] of (config.blocks ?? []).entries()) {
    blockItems.push(await buildLineup(block.sources, block.order, filler, seed + 7 * (i + 1)))
  }
  return { items, blockItems }
}

function parseBlockItems(json: string): ScheduleItem[][] {
  try {
    return (JSON.parse(json) as [string, number, number][][]).map((list) =>
      list.map(([mediaType, mediaId, seconds]) => ({
        mediaType: mediaType === 'movie' ? 'movie' : 'episode',
        mediaId,
        seconds
      }))
    )
  } catch {
    return []
  }
}

function minuteOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h < 24 && min < 60 ? h * 60 + min : null
}

// The channel's time blocks with their built play orders (blocks with a bad
// time or nothing to play are skipped).
function timeBlocks(config: ChannelConfig, blockItems: ScheduleItem[][]): TimeBlock[] {
  const blocks: TimeBlock[] = []
  ;(config.blocks ?? []).forEach((block: ChannelBlock, i) => {
    const startMinute = minuteOf(block.start)
    const endMinute = minuteOf(block.end)
    const items = blockItems[i] ?? []
    if (startMinute === null || endMinute === null || items.length === 0) return
    blocks.push({ startMinute, endMinute, items })
  })
  return blocks
}

function serialiseItems(items: ScheduleItem[]): string {
  return JSON.stringify(
    items.map((i) => [i.mediaType, i.mediaId, Math.round(i.seconds * 1000) / 1000])
  )
}

function serialiseBlocks(blockItems: ScheduleItem[][]): string {
  return JSON.stringify(
    blockItems.map((list) =>
      list.map((i) => [i.mediaType, i.mediaId, Math.round(i.seconds * 1000) / 1000])
    )
  )
}

function normaliseConfig(config: ChannelConfig): ChannelConfig {
  return {
    name: config.name.trim().slice(0, 60) || 'Channel',
    number: Number.isInteger(config.number) && config.number > 0 ? config.number : 1,
    sources: config.sources,
    order: config.order === 'inOrder' ? 'inOrder' : 'shuffle',
    maxQuality: ['1080', '720', '480'].includes(config.maxQuality) ? config.maxQuality : 'auto',
    blocks: (config.blocks ?? [])
      .filter((b) => minuteOf(b.start) !== null && minuteOf(b.end) !== null && b.sources.length > 0)
      .map((b) => ({
        start: b.start.trim(),
        end: b.end.trim(),
        sources: b.sources,
        order: b.order === 'inOrder' ? 'inOrder' : 'shuffle'
      })),
    filler: config.filler ?? [],
    logoPath: config.logoPath ?? null
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
  const { items, blockItems } = await buildItems(config, seed)
  let rowId: number
  if (existing) {
    db.prepare(
      `UPDATE channels SET number = ?, name = ?, config = ?, items = ?, block_items = ?,
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      config.number,
      config.name,
      JSON.stringify(config),
      serialiseItems(items),
      serialiseBlocks(blockItems),
      existing.id
    )
    rowId = existing.id
  } else {
    const result = db
      .prepare(
        `INSERT INTO channels (number, name, config, items, block_items, epoch, seed)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        config.number,
        config.name,
        JSON.stringify(config),
        serialiseItems(items),
        serialiseBlocks(blockItems),
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
        const { items, blockItems } = await buildItems(config, row.seed)
        db.prepare('UPDATE channels SET items = ?, block_items = ? WHERE id = ?').run(
          serialiseItems(items),
          serialiseBlocks(blockItems),
          row.id
        )
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
  const blocks = timeBlocks(JSON.parse(row.config), parseBlockItems(row.block_items))
  // What's on now and next, each cut to the time block it plays in.
  const [current, following] = programsBetween(items, blocks, row.epoch, t, t + 1, 2)
  const list = (block: number): ScheduleItem[] => (block === -1 ? items : blocks[block].items)
  if (!current) return null
  const now = program(list(current.block)[current.index], current.start, current.end)
  if (!now) return null
  const nextSlot =
    following ?? programsBetween(items, blocks, row.epoch, current.end, current.end + 1, 1)[0]
  return {
    channel: toChannel(row, items),
    program: now,
    // Into the file itself: a program cut in by a block boundary carries
    // on from where its item had got to.
    offsetSeconds: Math.max(0, (t - current.itemStart) / 1000),
    next: nextSlot ? program(list(nextSlot.block)[nextSlot.index], nextSlot.start, nextSlot.end) : null
  }
}

export function channelGuide(from: number, to: number): ChannelGuide {
  return {
    from,
    to,
    channels: rows().map((row) => {
      const items = parseItems(row.items)
      const blocks = timeBlocks(JSON.parse(row.config), parseBlockItems(row.block_items))
      const programs = programsBetween(items, blocks, row.epoch, from, to)
        .map((slot) =>
          program(
            (slot.block === -1 ? items : blocks[slot.block].items)[slot.index],
            slot.start,
            slot.end
          )
        )
        .filter((p): p is ChannelProgram => p !== null)
      return { channel: toChannel(row, items), programs }
    })
  }
}
