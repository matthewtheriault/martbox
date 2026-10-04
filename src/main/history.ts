import { db, getSetting, setSetting } from './db'
import { onStreamEnded, takeUsage, type EndedStream } from './dashboard'
import type { DashboardStats, PlayHistoryEntry } from '../shared/types'

// Watch history and usage stats for the dashboard (v3). A play is recorded
// when its stream ends (dashboard.ts) and it played for at least a minute;
// upload and the most streams at once are summed per hour. Both are kept
// for historyRetentionDays (default 90) and can be cleared from the
// dashboard. Admin only, like the rest of the dashboard.

db.exec(`
  CREATE TABLE IF NOT EXISTS play_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_name TEXT NOT NULL,
    device_name TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    media_type TEXT NOT NULL,
    media_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    method TEXT,
    channel TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    playing_seconds INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_play_history_started ON play_history(started_at);
  CREATE TABLE IF NOT EXISTS usage_hourly (
    hour INTEGER PRIMARY KEY,
    upload_bytes INTEGER NOT NULL DEFAULT 0,
    peak_streams INTEGER NOT NULL DEFAULT 0
  );
`)

const MIN_PLAY_SECONDS = 60
const DEFAULT_RETENTION_DAYS = 90
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export function retentionDays(): number {
  const days = parseInt(getSetting('historyRetentionDays') ?? '', 10)
  return Number.isInteger(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS
}

export function setRetentionDays(days: number): void {
  if (Number.isInteger(days) && days > 0 && days <= 3650) {
    setSetting('historyRetentionDays', String(days))
    purgeOld()
  }
}

function record(play: EndedStream): void {
  if (play.playingSeconds < MIN_PLAY_SECONDS) return
  db.prepare(
    `INSERT INTO play_history (profile_name, device_name, owner_key, media_type, media_id, title,
       subtitle, method, channel, started_at, ended_at, playing_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    play.profileName,
    play.deviceName,
    play.ownerKey,
    play.mediaType,
    play.mediaId,
    play.title,
    play.subtitle,
    play.method,
    play.channel,
    play.startedAt,
    play.endedAt,
    play.playingSeconds
  )
}

function flushUsage(): void {
  const { bytes, peakStreams } = takeUsage()
  const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
  db.prepare(
    `INSERT INTO usage_hourly (hour, upload_bytes, peak_streams) VALUES (?, ?, ?)
     ON CONFLICT(hour) DO UPDATE SET
       upload_bytes = upload_bytes + excluded.upload_bytes,
       peak_streams = MAX(peak_streams, excluded.peak_streams)`
  ).run(hour, bytes, peakStreams)
}

function purgeOld(): void {
  const cutoff = Date.now() - retentionDays() * DAY_MS
  db.prepare('DELETE FROM play_history WHERE started_at < ?').run(cutoff)
  db.prepare('DELETE FROM usage_hourly WHERE hour < ?').run(cutoff)
}

export function startHistory(): void {
  onStreamEnded(record)
  setInterval(flushUsage, 60_000).unref()
  setInterval(purgeOld, 6 * HOUR_MS).unref()
  purgeOld()
}

export function clearHistory(): void {
  db.exec('DELETE FROM play_history; DELETE FROM usage_hourly;')
}

interface HistoryRow {
  id: number
  profile_name: string
  device_name: string
  media_type: 'movie' | 'episode'
  media_id: number
  title: string
  subtitle: string
  method: PlayHistoryEntry['method']
  channel: string | null
  started_at: number
  ended_at: number
  playing_seconds: number
}

export function listHistory(limit = 100): PlayHistoryEntry[] {
  const rows = db
    .prepare('SELECT * FROM play_history ORDER BY started_at DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 1000)) as HistoryRow[]
  return rows.map((r) => ({
    id: r.id,
    profileName: r.profile_name,
    deviceName: r.device_name,
    mediaType: r.media_type,
    mediaId: r.media_id,
    title: r.title,
    subtitle: r.subtitle,
    method: r.method,
    channel: r.channel,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    playingSeconds: r.playing_seconds
  }))
}

const minutes = (seconds: number): number => Math.round(seconds / 60)

export function historyStats(days: number): DashboardStats {
  const since = Date.now() - days * DAY_MS
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS plays, COALESCE(SUM(playing_seconds), 0) AS seconds
       FROM play_history WHERE started_at >= ?`
    )
    .get(since) as { plays: number; seconds: number }
  const topTitles = (
    db
      .prepare(
        `SELECT title, COUNT(*) AS plays, SUM(playing_seconds) AS seconds FROM play_history
         WHERE started_at >= ? GROUP BY title ORDER BY seconds DESC LIMIT 8`
      )
      .all(since) as { title: string; plays: number; seconds: number }[]
  ).map((r) => ({ title: r.title, plays: r.plays, minutes: minutes(r.seconds) }))
  const byUser = (
    db
      .prepare(
        `SELECT profile_name, COUNT(*) AS plays, SUM(playing_seconds) AS seconds FROM play_history
         WHERE started_at >= ? GROUP BY profile_name ORDER BY seconds DESC`
      )
      .all(since) as { profile_name: string; plays: number; seconds: number }[]
  ).map((r) => ({
    profileName: r.profile_name || 'Unknown',
    plays: r.plays,
    minutes: minutes(r.seconds)
  }))
  const peak = db
    .prepare('SELECT COALESCE(MAX(peak_streams), 0) AS peak FROM usage_hourly WHERE hour >= ?')
    .get(since) as { peak: number }
  // Upload per local day.
  const byDay = new Map<string, number>()
  for (let i = days - 1; i >= 0; i--) {
    byDay.set(new Date(Date.now() - i * DAY_MS).toLocaleDateString('en-CA'), 0)
  }
  for (const row of db
    .prepare('SELECT hour, upload_bytes FROM usage_hourly WHERE hour >= ?')
    .all(since) as { hour: number; upload_bytes: number }[]) {
    const day = new Date(row.hour).toLocaleDateString('en-CA')
    if (byDay.has(day)) byDay.set(day, (byDay.get(day) ?? 0) + row.upload_bytes)
  }
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
  return {
    days,
    plays: totals.plays,
    minutesWatched: minutes(totals.seconds),
    topTitles,
    byUser,
    peakStreams: peak.peak,
    uploadByDay: [...byDay.entries()].map(([day, bytes]) => ({ day, bytes })),
    library: {
      movies: count('SELECT COUNT(*) AS n FROM movies'),
      shows: count('SELECT COUNT(*) AS n FROM shows'),
      episodes: count('SELECT COUNT(*) AS n FROM episodes')
    },
    retentionDays: retentionDays()
  }
}
