import { db } from './db'
import type {
  MediaRequest,
  MediaRequestStatus,
  RequestMediaType,
  RequestTitleDetails,
  RequestableTitle
} from '../shared/types'
import type { RequestTitleInfo } from './tmdb'

// Requests: friends ask for a movie or show (or some seasons of one) from
// the apps; the admin approves or declines them in the host's Dashboard.
// A request becomes Available by itself once a library scan finds the title
// — checked whenever requests are read, so it never needs a scan hook.
//
// Replaces RQSTMart (a separate app that sent each request as a phone
// notification).

db.exec(`
  CREATE TABLE IF NOT EXISTS media_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
    title TEXT NOT NULL,
    year INTEGER,
    poster_url TEXT,
    -- JSON array of season numbers; NULL for movies, and for a show TMDB
    -- lists no seasons for yet.
    seasons TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'declined', 'available')),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_media_requests_title ON media_requests(media_type, tmdb_id);
  CREATE INDEX IF NOT EXISTS idx_media_requests_profile ON media_requests(profile_id);
`)

interface RequestRow {
  id: number
  profile_id: number
  profile_name: string | null
  tmdb_id: number
  media_type: RequestMediaType
  title: string
  year: number | null
  poster_url: string | null
  seasons: string | null
  status: MediaRequestStatus
  note: string | null
  created_at: string
  updated_at: string
}

function parseSeasons(value: string | null): number[] | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((n) => Number.isInteger(n)) : null
  } catch {
    return null
  }
}

// What the library holds for a TMDB title.
export function libraryHolding(
  mediaType: RequestMediaType,
  tmdbId: number
): { movieId: number | null; showId: number | null; seasons: number[] } | null {
  if (mediaType === 'movie') {
    const row = db.prepare('SELECT id FROM movies WHERE tmdb_id = ? LIMIT 1').get(tmdbId) as
      | { id: number }
      | undefined
    return row ? { movieId: row.id, showId: null, seasons: [] } : null
  }
  const show = db.prepare('SELECT id FROM shows WHERE tmdb_id = ? LIMIT 1').get(tmdbId) as
    | { id: number }
    | undefined
  if (!show) return null
  const seasons = (
    db
      .prepare(
        `SELECT DISTINCT season_number FROM episodes
         WHERE show_id = ? AND season_number > 0 ORDER BY season_number`
      )
      .all(show.id) as { season_number: number }[]
  ).map((r) => r.season_number)
  return { movieId: null, showId: show.id, seasons }
}

// Whether the library now has everything the request asked for. A whole-show
// request counts as soon as the show is there.
function isFulfilled(row: RequestRow): boolean {
  const holding = libraryHolding(row.media_type, row.tmdb_id)
  if (!holding) return false
  const seasons = parseSeasons(row.seasons)
  if (row.media_type === 'movie' || !seasons) return true
  return seasons.every((s) => holding.seasons.includes(s))
}

function markFulfilled(): void {
  const open = db
    .prepare(`SELECT * FROM media_requests WHERE status IN ('pending', 'approved')`)
    .all() as RequestRow[]
  const mark = db.prepare(
    `UPDATE media_requests SET status = 'available', updated_at = datetime('now') WHERE id = ?`
  )
  for (const row of open) {
    if (isFulfilled(row)) mark.run(row.id)
  }
}

function toRequest(row: RequestRow): MediaRequest {
  const holding = row.status === 'available' ? libraryHolding(row.media_type, row.tmdb_id) : null
  return {
    id: row.id,
    tmdbId: row.tmdb_id,
    mediaType: row.media_type,
    title: row.title,
    year: row.year,
    posterUrl: row.poster_url,
    seasons: parseSeasons(row.seasons),
    status: row.status,
    note: row.note,
    profileId: row.profile_id,
    profileName: row.profile_name ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    libraryMovieId: holding?.movieId ?? null,
    libraryShowId: holding?.showId ?? null
  }
}

const SELECT_REQUESTS = `
  SELECT r.*, p.name AS profile_name
  FROM media_requests r LEFT JOIN profiles p ON p.id = r.profile_id`

// Newest first. Pass a profile for that user's own requests.
export function listRequests(profileId?: number): MediaRequest[] {
  markFulfilled()
  const rows = (
    profileId === undefined
      ? db.prepare(`${SELECT_REQUESTS} ORDER BY r.created_at DESC, r.id DESC`).all()
      : db
          .prepare(
            `${SELECT_REQUESTS} WHERE r.profile_id = ? ORDER BY r.created_at DESC, r.id DESC`
          )
          .all(profileId)
  ) as RequestRow[]
  return rows.map(toRequest)
}

export function pendingRequestCount(): number {
  markFulfilled()
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM media_requests WHERE status = 'pending'`)
    .get() as { n: number }
  return row.n
}

function openRequestsFor(mediaType: RequestMediaType, tmdbId: number): MediaRequest[] {
  const rows = db
    .prepare(
      `${SELECT_REQUESTS}
       WHERE r.media_type = ? AND r.tmdb_id = ? AND r.status IN ('pending', 'approved')
       ORDER BY r.created_at`
    )
    .all(mediaType, tmdbId) as RequestRow[]
  return rows.map(toRequest)
}

export function titleDetails(info: RequestTitleInfo): RequestTitleDetails {
  markFulfilled()
  return {
    ...info,
    library: libraryHolding(info.mediaType, info.tmdbId),
    requests: openRequestsFor(info.mediaType, info.tmdbId)
  }
}

export type CreateRequestResult =
  | { ok: true; request: MediaRequest }
  | { ok: false; reason: 'in-library' | 'already-requested' | 'no-seasons'; by?: string }

// Seasons already on the server or already asked for (by anyone) are left
// out; if nothing is left, the request isn't made.
export function createRequest(
  profileId: number,
  info: RequestTitleInfo,
  wantedSeasons: number[] | null
): CreateRequestResult {
  markFulfilled()
  const holding = libraryHolding(info.mediaType, info.tmdbId)
  const open = openRequestsFor(info.mediaType, info.tmdbId)
  let seasons: number[] | null = null

  if (info.mediaType === 'movie') {
    if (holding) return { ok: false, reason: 'in-library' }
    if (open.length > 0) return { ok: false, reason: 'already-requested', by: open[0].profileName }
  } else {
    const known = info.seasons.map((s) => s.number)
    const asked = wantedSeasons && wantedSeasons.length > 0 ? wantedSeasons : known
    const requested = new Set(open.flatMap((r) => r.seasons ?? known))
    seasons = [...new Set(asked)]
      .filter((n) => known.length === 0 || known.includes(n))
      .filter((n) => !(holding?.seasons ?? []).includes(n) && !requested.has(n))
      .sort((a, b) => a - b)
    if (seasons.length === 0) {
      if (open.length > 0) {
        return { ok: false, reason: 'already-requested', by: open[0].profileName }
      }
      if (holding) return { ok: false, reason: 'in-library' }
      // TMDB lists no seasons yet (an announced show): request it whole.
      if (known.length > 0) return { ok: false, reason: 'no-seasons' }
      seasons = null
    }
  }

  const result = db
    .prepare(
      `INSERT INTO media_requests
         (profile_id, tmdb_id, media_type, title, year, poster_url, seasons)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      profileId,
      info.tmdbId,
      info.mediaType,
      info.title,
      info.year,
      info.posterUrl,
      seasons ? JSON.stringify(seasons) : null
    )
  const row = db
    .prepare(`${SELECT_REQUESTS} WHERE r.id = ?`)
    .get(result.lastInsertRowid) as RequestRow
  return { ok: true, request: toRequest(row) }
}

// A user can take back their own request while it's still pending.
export function cancelRequest(id: number, profileId: number): boolean {
  const result = db
    .prepare(`DELETE FROM media_requests WHERE id = ? AND profile_id = ? AND status = 'pending'`)
    .run(id, profileId)
  return result.changes > 0
}

// Admin: approve / decline (with a note) / back to pending / available.
export function setRequestStatus(
  id: number,
  status: MediaRequestStatus,
  note: string | null
): void {
  db.prepare(
    `UPDATE media_requests SET status = ?, note = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(status, note?.trim() ? note.trim().slice(0, 300) : null, id)
}

export function deleteRequest(id: number): void {
  db.prepare('DELETE FROM media_requests WHERE id = ?').run(id)
}

// Marks browse/search results that are already on MartBox or requested.
export function annotateTitles(items: RequestableTitle[]): RequestableTitle[] {
  markFulfilled()
  const status = db.prepare(
    `SELECT status FROM media_requests
     WHERE media_type = ? AND tmdb_id = ? AND status IN ('pending', 'approved')
     ORDER BY created_at DESC LIMIT 1`
  )
  return items.map((item) => ({
    ...item,
    onServer: libraryHolding(item.mediaType, item.tmdbId) !== null,
    requestStatus:
      (status.get(item.mediaType, item.tmdbId) as { status: MediaRequestStatus } | undefined)
        ?.status ?? null
  }))
}
