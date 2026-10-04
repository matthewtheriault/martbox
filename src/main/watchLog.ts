import { db, getSetting, setSetting } from './db'
import type { YearInReview, YearInReviewTitle } from '../shared/types'

// How long each profile watched what, per day, kept for good (Year in
// Review). Counted from progress saves: the position moving forward by
// about as much time as passed since the last save is watching; a jump
// (a seek) isn't.

db.exec(`
  CREATE TABLE IF NOT EXISTS watch_log (
    profile_id INTEGER NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'episode')),
    media_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    seconds INTEGER NOT NULL,
    PRIMARY KEY (profile_id, media_type, media_id, day)
  );
  CREATE INDEX IF NOT EXISTS idx_watch_log_day ON watch_log(profile_id, day);
`)

// A save more than this long after the last one starts a new session.
const MAX_GAP_SECONDS = 600

export function localDay(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function add(profileId: number, mediaType: string, mediaId: number, day: string, seconds: number): void {
  db.prepare(
    `INSERT INTO watch_log (profile_id, media_type, media_id, day, seconds) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, media_type, media_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`
  ).run(profileId, mediaType, mediaId, day, Math.round(seconds))
}

// Called with the saved progress before it's overwritten.
export function noteProgress(
  profileId: number,
  mediaType: string,
  mediaId: number,
  previous: { position: number; updatedAt: string } | null,
  position: number,
  now = Date.now()
): void {
  if (!previous || (mediaType !== 'movie' && mediaType !== 'episode')) return
  // watch_progress.updated_at is SQLite's datetime('now'), in UTC.
  const then = Date.parse(previous.updatedAt.replace(' ', 'T') + 'Z')
  if (!Number.isFinite(then)) return
  const wall = (now - then) / 1000
  const moved = position - previous.position
  if (wall <= 0 || wall > MAX_GAP_SECONDS || moved <= 0) return
  // A little slack for timers; anything well past the wall clock is a seek.
  if (moved > wall * 1.3 + 3) return
  add(profileId, mediaType, mediaId, localDay(now), moved)
}

// Once: the dashboard's watch history (the last 90 days, by profile name)
// so the first Year in Review isn't empty.
export function seedFromPlayHistory(): void {
  if (getSetting('watchLogSeeded')) return
  setSetting('watchLogSeeded', '1')
  const hasHistory = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'play_history'")
    .get()
  if (!hasHistory) return
  const profiles = db.prepare('SELECT id, name FROM profiles').all() as { id: number; name: string }[]
  const byName = new Map<string, number>()
  for (const p of profiles) byName.set(p.name, byName.has(p.name) ? -1 : p.id)
  const plays = db
    .prepare(
      `SELECT profile_name, media_type, media_id, started_at, playing_seconds FROM play_history
       WHERE media_type IN ('movie', 'episode')`
    )
    .all() as { profile_name: string; media_type: string; media_id: number; started_at: number; playing_seconds: number }[]
  db.transaction(() => {
    for (const p of plays) {
      const id = byName.get(p.profile_name)
      if (id && id > 0) add(id, p.media_type, p.media_id, localDay(p.started_at), p.playing_seconds)
    }
  })()
}

export function reviewYears(profileId: number): number[] {
  return (
    db
      .prepare('SELECT DISTINCT substr(day, 1, 4) AS y FROM watch_log WHERE profile_id = ? ORDER BY y DESC')
      .all(profileId) as { y: string }[]
  ).map((r) => Number(r.y))
}

function parseGenres(raw: string | null): string[] {
  try {
    const g = JSON.parse(raw ?? '[]')
    return Array.isArray(g) ? g.map(String) : []
  } catch {
    return []
  }
}

export function yearInReview(profileId: number, year: number): YearInReview {
  const rows = db
    .prepare(
      `SELECT w.media_type AS type, w.media_id AS id, w.day, w.seconds,
         e.show_id AS showId
       FROM watch_log w
       LEFT JOIN episodes e ON w.media_type = 'episode' AND e.id = w.media_id
       WHERE w.profile_id = ? AND w.day >= ? AND w.day <= ?
       ORDER BY w.day`
    )
    .all(profileId, `${year}-01-01`, `${year}-12-31`) as {
    type: 'movie' | 'episode'
    id: number
    day: string
    seconds: number
    showId: number | null
  }[]

  const months = new Array(12).fill(0)
  const weekdays = new Array(7).fill(0)
  const days = new Map<string, number>()
  const titles = new Map<string, { kind: 'movie' | 'show'; id: number; seconds: number }>()
  const episodes = new Set<number>()
  const movies = new Set<number>()
  let total = 0
  for (const r of rows) {
    total += r.seconds
    const [y, m, d] = r.day.split('-').map(Number)
    months[m - 1] += r.seconds
    weekdays[new Date(y, m - 1, d).getDay()] += r.seconds
    days.set(r.day, (days.get(r.day) ?? 0) + r.seconds)
    if (r.type === 'episode') episodes.add(r.id)
    else movies.add(r.id)
    const kind = r.type === 'movie' ? 'movie' : 'show'
    const id = r.type === 'movie' ? r.id : r.showId
    if (id === null) continue
    const key = `${kind}:${id}`
    const t = titles.get(key) ?? { kind, id, seconds: 0 }
    t.seconds += r.seconds
    titles.set(key, t)
  }

  const describe = (kind: 'movie' | 'show', id: number, seconds: number): YearInReviewTitle | null => {
    const row = db
      .prepare(`SELECT title, year, poster_path, genres FROM ${kind === 'movie' ? 'movies' : 'shows'} WHERE id = ?`)
      .get(id) as { title: string; year: number | null; poster_path: string | null; genres: string | null } | undefined
    if (!row) return null
    return { mediaType: kind, id, title: row.title, year: row.year, posterPath: row.poster_path, seconds }
  }

  const ranked = [...titles.values()].sort((a, b) => b.seconds - a.seconds)
  const top = (kind: 'movie' | 'show'): YearInReviewTitle[] =>
    ranked
      .filter((t) => t.kind === kind)
      .slice(0, 5)
      .map((t) => describe(t.kind, t.id, t.seconds))
      .filter((t): t is YearInReviewTitle => t !== null)

  const genreSeconds = new Map<string, number>()
  for (const t of ranked) {
    const row = db
      .prepare(`SELECT genres FROM ${t.kind === 'movie' ? 'movies' : 'shows'} WHERE id = ?`)
      .get(t.id) as { genres: string | null } | undefined
    for (const g of parseGenres(row?.genres ?? null)) genreSeconds.set(g, (genreSeconds.get(g) ?? 0) + t.seconds)
  }

  let busiestDay: { day: string; seconds: number } | null = null
  for (const [day, seconds] of days) if (!busiestDay || seconds > busiestDay.seconds) busiestDay = { day, seconds }

  // Longest run of consecutive days with anything watched.
  let longestStreak = 0
  let run = 0
  let prev: number | null = null
  for (const day of [...days.keys()].sort()) {
    const [y, m, d] = day.split('-').map(Number)
    const t = new Date(y, m - 1, d).getTime()
    run = prev !== null && Math.round((t - prev) / 86_400_000) === 1 ? run + 1 : 1
    longestStreak = Math.max(longestStreak, run)
    prev = t
  }

  const first = rows[0]
  const firstTitle = first
    ? describe(
        first.type === 'movie' ? 'movie' : 'show',
        first.type === 'movie' ? first.id : (first.showId ?? -1),
        0
      )
    : null

  const finished = db
    .prepare(
      `SELECT COUNT(*) AS n FROM watch_progress WHERE profile_id = ? AND watched = 1
       AND updated_at >= ? AND updated_at < ?`
    )
    .get(profileId, `${year}-01-01`, `${year + 1}-01-01`) as { n: number }

  return {
    year,
    years: reviewYears(profileId),
    totalSeconds: total,
    daysWatched: days.size,
    moviesWatched: movies.size,
    episodesWatched: episodes.size,
    showsWatched: ranked.filter((t) => t.kind === 'show').length,
    finished: finished.n,
    topShows: top('show'),
    topMovies: top('movie'),
    topGenres: [...genreSeconds.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, seconds]) => ({ name, seconds })),
    monthSeconds: months,
    weekdaySeconds: weekdays,
    busiestDay,
    longestStreak,
    firstTitle: firstTitle && first ? { ...firstTitle, day: first.day } : null
  }
}
