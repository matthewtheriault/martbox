import { db } from './db'
import type {
  ActivityItem,
  ContinueWatchingItem,
  Episode,
  IptvChannel,
  Library,
  MediaType,
  Movie,
  Profile,
  Show,
  WatchProgress
} from '../shared/types'
import type { ParsedIptvChannel, ParsedProgramme } from './iptvParser'

/* ---------- row -> type mappers ---------- */

function rowToLibrary(r: any): Library {
  return { id: r.id, path: r.path, type: r.type, name: r.name }
}

function rowToMovie(r: any): Movie {
  return {
    id: r.id,
    libraryId: r.library_id,
    filePath: r.file_path,
    title: r.title,
    sortTitle: r.sort_title,
    year: r.year,
    tmdbId: r.tmdb_id,
    overview: r.overview,
    posterPath: r.poster_path,
    backdropPath: r.backdrop_path,
    rating: r.rating,
    runtimeMinutes: r.runtime_minutes,
    addedAt: r.added_at
  }
}

function rowToShow(r: any): Show {
  return {
    id: r.id,
    libraryId: r.library_id,
    folderPath: r.folder_path,
    title: r.title,
    sortTitle: r.sort_title,
    year: r.year,
    tmdbId: r.tmdb_id,
    overview: r.overview,
    posterPath: r.poster_path,
    backdropPath: r.backdrop_path,
    rating: r.rating
  }
}

function rowToEpisode(r: any): Episode {
  return {
    id: r.id,
    showId: r.show_id,
    seasonNumber: r.season_number,
    episodeNumber: r.episode_number,
    filePath: r.file_path,
    title: r.title,
    overview: r.overview,
    stillPath: r.still_path,
    airDate: r.air_date,
    durationSeconds: r.duration_seconds
  }
}

function rowToProfile(r: any): Profile {
  return {
    id: r.id,
    name: r.name,
    avatarId: r.avatar_id,
    createdAt: r.created_at,
    isAdmin: !!r.is_admin
  }
}

/* ---------- profiles ---------- */

export function listProfiles(): Profile[] {
  return (db.prepare('SELECT * FROM profiles ORDER BY id').all() as any[]).map(rowToProfile)
}

export function createProfile(name: string, avatarId: string): Profile {
  // Whoever creates the first profile ever (always the host, before any
  // friend joins) is the admin — no manual toggle needed.
  const isFirst = listProfiles().length === 0
  const info = db
    .prepare('INSERT INTO profiles (name, avatar_id, is_admin) VALUES (?, ?, ?)')
    .run(name, avatarId, isFirst ? 1 : 0)
  return rowToProfile(db.prepare('SELECT * FROM profiles WHERE id = ?').get(info.lastInsertRowid))
}

export function renameProfile(id: number, name: string): void {
  db.prepare('UPDATE profiles SET name = ? WHERE id = ?').run(name, id)
}

export function deleteProfile(id: number): void {
  db.prepare('DELETE FROM profiles WHERE id = ?').run(id)
}

/* ---------- libraries ---------- */

export function listLibraries(): Library[] {
  return (db.prepare('SELECT * FROM libraries ORDER BY name').all() as any[]).map(rowToLibrary)
}

export function addLibrary(path: string, type: 'movie' | 'tv', name: string): Library {
  const info = db
    .prepare('INSERT INTO libraries (path, type, name) VALUES (?, ?, ?)')
    .run(path, type, name)
  return rowToLibrary(
    db.prepare('SELECT * FROM libraries WHERE id = ?').get(info.lastInsertRowid)
  )
}

export function removeLibrary(id: number): void {
  db.prepare('DELETE FROM libraries WHERE id = ?').run(id)
}

export function getLibrary(id: number): Library | null {
  const row = db.prepare('SELECT * FROM libraries WHERE id = ?').get(id)
  return row ? rowToLibrary(row) : null
}

/* ---------- movies ---------- */

export function upsertMovie(m: Omit<Movie, 'id' | 'addedAt'>): Movie {
  db.prepare(
    `INSERT INTO movies (library_id, file_path, title, sort_title, year, tmdb_id, overview, poster_path, backdrop_path, rating, runtime_minutes)
     VALUES (@libraryId, @filePath, @title, @sortTitle, @year, @tmdbId, @overview, @posterPath, @backdropPath, @rating, @runtimeMinutes)
     ON CONFLICT(file_path) DO UPDATE SET
       title = excluded.title, sort_title = excluded.sort_title, year = excluded.year,
       tmdb_id = excluded.tmdb_id, overview = excluded.overview, poster_path = excluded.poster_path,
       backdrop_path = excluded.backdrop_path, rating = excluded.rating, runtime_minutes = excluded.runtime_minutes`
  ).run(m as any)
  return rowToMovie(db.prepare('SELECT * FROM movies WHERE file_path = ?').get(m.filePath))
}

export function listMovies(libraryId?: number): Movie[] {
  const rows = libraryId
    ? db.prepare('SELECT * FROM movies WHERE library_id = ? ORDER BY sort_title').all(libraryId)
    : db.prepare('SELECT * FROM movies ORDER BY sort_title').all()
  return (rows as any[]).map(rowToMovie)
}

export function getMovie(id: number): Movie | null {
  const row = db.prepare('SELECT * FROM movies WHERE id = ?').get(id)
  return row ? rowToMovie(row) : null
}

/* ---------- shows / episodes ---------- */

export function upsertShow(s: Omit<Show, 'id'>): Show {
  db.prepare(
    `INSERT INTO shows (library_id, folder_path, title, sort_title, year, tmdb_id, overview, poster_path, backdrop_path, rating)
     VALUES (@libraryId, @folderPath, @title, @sortTitle, @year, @tmdbId, @overview, @posterPath, @backdropPath, @rating)
     ON CONFLICT(folder_path) DO UPDATE SET
       title = excluded.title, sort_title = excluded.sort_title, year = excluded.year,
       tmdb_id = excluded.tmdb_id, overview = excluded.overview, poster_path = excluded.poster_path,
       backdrop_path = excluded.backdrop_path, rating = excluded.rating`
  ).run(s as any)
  return rowToShow(db.prepare('SELECT * FROM shows WHERE folder_path = ?').get(s.folderPath))
}

export function listShows(libraryId?: number): Show[] {
  const rows = libraryId
    ? db.prepare('SELECT * FROM shows WHERE library_id = ? ORDER BY sort_title').all(libraryId)
    : db.prepare('SELECT * FROM shows ORDER BY sort_title').all()
  return (rows as any[]).map(rowToShow)
}

export function getShow(id: number): Show | null {
  const row = db.prepare('SELECT * FROM shows WHERE id = ?').get(id)
  return row ? rowToShow(row) : null
}

export function upsertEpisode(e: Omit<Episode, 'id'>): Episode {
  db.prepare(
    `INSERT INTO episodes (show_id, season_number, episode_number, file_path, title, overview, still_path, air_date, duration_seconds)
     VALUES (@showId, @seasonNumber, @episodeNumber, @filePath, @title, @overview, @stillPath, @airDate, @durationSeconds)
     ON CONFLICT(file_path) DO UPDATE SET
       title = excluded.title, overview = excluded.overview, still_path = excluded.still_path,
       air_date = excluded.air_date, duration_seconds = excluded.duration_seconds`
  ).run(e as any)
  return rowToEpisode(db.prepare('SELECT * FROM episodes WHERE file_path = ?').get(e.filePath))
}

export function listEpisodes(showId: number): Episode[] {
  return (
    db
      .prepare(
        'SELECT * FROM episodes WHERE show_id = ? ORDER BY season_number, episode_number'
      )
      .all(showId) as any[]
  ).map(rowToEpisode)
}

export function getEpisode(id: number): Episode | null {
  const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(id)
  return row ? rowToEpisode(row) : null
}

/* ---------- watch progress ---------- */

export function saveProgress(
  profileId: number,
  mediaType: MediaType,
  mediaId: number,
  positionSeconds: number,
  durationSeconds: number
): void {
  const watched = durationSeconds > 0 && positionSeconds / durationSeconds >= 0.92 ? 1 : 0
  db.prepare(
    `INSERT INTO watch_progress (profile_id, media_type, media_id, position_seconds, duration_seconds, watched, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(profile_id, media_type, media_id) DO UPDATE SET
       position_seconds = excluded.position_seconds,
       duration_seconds = excluded.duration_seconds,
       watched = excluded.watched,
       updated_at = excluded.updated_at`
  ).run(profileId, mediaType, mediaId, positionSeconds, durationSeconds, watched)
}

export function getProgress(
  profileId: number,
  mediaType: MediaType,
  mediaId: number
): WatchProgress | null {
  const row = db
    .prepare('SELECT * FROM watch_progress WHERE profile_id = ? AND media_type = ? AND media_id = ?')
    .get(profileId, mediaType, mediaId) as any
  if (!row) return null
  return {
    profileId: row.profile_id,
    mediaType: row.media_type,
    mediaId: row.media_id,
    positionSeconds: row.position_seconds,
    durationSeconds: row.duration_seconds,
    watched: !!row.watched,
    updatedAt: row.updated_at
  }
}

export function setWatched(
  profileId: number,
  mediaType: MediaType,
  mediaId: number,
  watched: boolean
): void {
  db.prepare(
    `INSERT INTO watch_progress (profile_id, media_type, media_id, position_seconds, duration_seconds, watched, updated_at)
     VALUES (?, ?, 0, 0, ?, datetime('now'))
     ON CONFLICT(profile_id, media_type, media_id) DO UPDATE SET watched = excluded.watched, updated_at = excluded.updated_at`
  ).run(profileId, mediaType, mediaId, watched ? 1 : 0)
}

export function getContinueWatching(profileId: number, limit = 20): ContinueWatchingItem[] {
  const rows = db
    .prepare(
      `SELECT wp.media_type, wp.media_id, wp.position_seconds, wp.duration_seconds, wp.updated_at
       FROM watch_progress wp
       WHERE wp.profile_id = ? AND wp.watched = 0 AND wp.position_seconds > 0
       ORDER BY wp.updated_at DESC
       LIMIT ?`
    )
    .all(profileId, limit) as any[]

  const items: ContinueWatchingItem[] = []
  for (const row of rows) {
    if (row.media_type === 'movie') {
      const movie = getMovie(row.media_id)
      if (!movie) continue
      items.push({
        mediaType: 'movie',
        mediaId: movie.id,
        positionSeconds: row.position_seconds,
        durationSeconds: row.duration_seconds,
        updatedAt: row.updated_at,
        title: movie.title,
        subtitle: movie.year ? String(movie.year) : null,
        posterPath: movie.posterPath,
        backdropPath: movie.backdropPath,
        showId: null,
        seasonNumber: null,
        episodeNumber: null
      })
    } else {
      const episode = getEpisode(row.media_id)
      if (!episode) continue
      const show = getShow(episode.showId)
      items.push({
        mediaType: 'episode',
        mediaId: episode.id,
        positionSeconds: row.position_seconds,
        durationSeconds: row.duration_seconds,
        updatedAt: row.updated_at,
        title: show?.title ?? episode.title,
        subtitle: `S${episode.seasonNumber}:E${episode.episodeNumber} ${episode.title}`,
        posterPath: show?.posterPath ?? null,
        backdropPath: show?.backdropPath ?? null,
        showId: episode.showId,
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber
      })
    }
  }
  return items
}

export function getNextEpisodeToWatch(profileId: number, showId: number): Episode | null {
  const episodes = listEpisodes(showId)
  for (const ep of episodes) {
    const progress = getProgress(profileId, 'episode', ep.id)
    if (!progress || !progress.watched) return ep
  }
  return null
}

// Admin-only view: every profile's watch activity (in-progress and
// completed), most recent first. Same shape as getContinueWatching but
// without the profile_id filter or the watched=0 exclusion.
export function getAllActivity(limit = 100): ActivityItem[] {
  const rows = db
    .prepare(
      `SELECT wp.profile_id, p.name as profile_name, p.avatar_id as profile_avatar_id,
              wp.media_type, wp.media_id, wp.position_seconds, wp.duration_seconds,
              wp.watched, wp.updated_at
       FROM watch_progress wp
       JOIN profiles p ON p.id = wp.profile_id
       ORDER BY wp.updated_at DESC
       LIMIT ?`
    )
    .all(limit) as any[]

  const items: ActivityItem[] = []
  for (const row of rows) {
    const base = {
      profileId: row.profile_id,
      profileName: row.profile_name,
      profileAvatarId: row.profile_avatar_id,
      positionSeconds: row.position_seconds,
      durationSeconds: row.duration_seconds,
      watched: !!row.watched,
      updatedAt: row.updated_at
    }
    if (row.media_type === 'movie') {
      const movie = getMovie(row.media_id)
      if (!movie) continue
      items.push({
        ...base,
        mediaType: 'movie',
        mediaId: movie.id,
        title: movie.title,
        subtitle: movie.year ? String(movie.year) : null,
        posterPath: movie.posterPath,
        backdropPath: movie.backdropPath
      })
    } else {
      const episode = getEpisode(row.media_id)
      if (!episode) continue
      const show = getShow(episode.showId)
      items.push({
        ...base,
        mediaType: 'episode',
        mediaId: episode.id,
        title: show?.title ?? episode.title,
        subtitle: `S${episode.seasonNumber}:E${episode.episodeNumber} ${episode.title}`,
        posterPath: show?.posterPath ?? null,
        backdropPath: show?.backdropPath ?? null
      })
    }
  }
  return items
}

/* ---------- live tv (iptv) ---------- */

function rowToIptvChannel(r: any): Omit<IptvChannel, 'nowPlayingTitle' | 'nowPlayingEndsAt'> {
  return {
    id: r.id,
    tvgId: r.tvg_id,
    name: r.name,
    logoUrl: r.logo_url,
    groupTitle: r.group_title,
    sortOrder: r.sort_order
  }
}

export function replaceIptvData(channels: ParsedIptvChannel[], programmes: ParsedProgramme[]): void {
  const tx = db.transaction(() => {
    db.exec('DELETE FROM iptv_programmes')
    db.exec('DELETE FROM iptv_channels')

    const insertChannel = db.prepare(
      `INSERT INTO iptv_channels (tvg_id, name, logo_url, group_title, stream_url, sort_order)
       VALUES (@tvgId, @name, @logoUrl, @groupTitle, @streamUrl, @sortOrder)`
    )
    channels.forEach((c, i) => insertChannel.run({ ...c, sortOrder: i }))

    const insertProgramme = db.prepare(
      `INSERT INTO iptv_programmes (channel_tvg_id, title, description, start_at, stop_at)
       VALUES (@channelTvgId, @title, @description, @startAt, @stopAt)`
    )
    for (const p of programmes) insertProgramme.run(p)
  })
  tx()
}

// Public shape — deliberately omits stream_url, which can embed an IPTV
// account's username/password as query params. Never expose it over IPC or
// the /api/* HTTP surface; only getIptvChannelStreamUrl (below) may touch it.
export function listIptvChannels(): IptvChannel[] {
  const channels = (db.prepare('SELECT * FROM iptv_channels ORDER BY sort_order').all() as any[]).map(
    rowToIptvChannel
  )
  const nowIso = new Date().toISOString()
  const airing = db
    .prepare(
      'SELECT channel_tvg_id, title, stop_at FROM iptv_programmes WHERE start_at <= ? AND stop_at > ?'
    )
    .all(nowIso, nowIso) as any[]
  const byChannel = new Map(airing.map((r) => [r.channel_tvg_id, r]))

  return channels.map((c) => {
    const nowPlaying = c.tvgId ? byChannel.get(c.tvgId) : undefined
    return {
      ...c,
      nowPlayingTitle: nowPlaying?.title ?? null,
      nowPlayingEndsAt: nowPlaying?.stop_at ?? null
    }
  })
}

// Internal only — called exclusively from mediaServer.ts's /live proxy route
// in-process. Never serialize this value over IPC or /api/*.
export function getIptvChannelStreamUrl(id: number): string | null {
  const row = db.prepare('SELECT stream_url FROM iptv_channels WHERE id = ?').get(id) as
    | { stream_url: string }
    | undefined
  return row?.stream_url ?? null
}
