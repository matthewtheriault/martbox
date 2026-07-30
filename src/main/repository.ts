import { db } from './db'
import type {
  ContinueWatchingItem,
  Episode,
  Library,
  MediaType,
  Movie,
  Show,
  WatchProgress
} from '../shared/types'

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
  mediaType: MediaType,
  mediaId: number,
  positionSeconds: number,
  durationSeconds: number
): void {
  const watched = durationSeconds > 0 && positionSeconds / durationSeconds >= 0.92 ? 1 : 0
  db.prepare(
    `INSERT INTO watch_progress (media_type, media_id, position_seconds, duration_seconds, watched, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(media_type, media_id) DO UPDATE SET
       position_seconds = excluded.position_seconds,
       duration_seconds = excluded.duration_seconds,
       watched = excluded.watched,
       updated_at = excluded.updated_at`
  ).run(mediaType, mediaId, positionSeconds, durationSeconds, watched)
}

export function getProgress(mediaType: MediaType, mediaId: number): WatchProgress | null {
  const row = db
    .prepare('SELECT * FROM watch_progress WHERE media_type = ? AND media_id = ?')
    .get(mediaType, mediaId) as any
  if (!row) return null
  return {
    mediaType: row.media_type,
    mediaId: row.media_id,
    positionSeconds: row.position_seconds,
    durationSeconds: row.duration_seconds,
    watched: !!row.watched,
    updatedAt: row.updated_at
  }
}

export function setWatched(mediaType: MediaType, mediaId: number, watched: boolean): void {
  db.prepare(
    `INSERT INTO watch_progress (media_type, media_id, position_seconds, duration_seconds, watched, updated_at)
     VALUES (?, 0, 0, ?, datetime('now'))
     ON CONFLICT(media_type, media_id) DO UPDATE SET watched = excluded.watched, updated_at = excluded.updated_at`
  ).run(mediaType, mediaId, watched ? 1 : 0)
}

export function getContinueWatching(limit = 20): ContinueWatchingItem[] {
  const rows = db
    .prepare(
      `SELECT wp.media_type, wp.media_id, wp.position_seconds, wp.duration_seconds, wp.updated_at
       FROM watch_progress wp
       WHERE wp.watched = 0 AND wp.position_seconds > 0
       ORDER BY wp.updated_at DESC
       LIMIT ?`
    )
    .all(limit) as any[]

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

export function getNextEpisodeToWatch(showId: number): Episode | null {
  const episodes = listEpisodes(showId)
  for (const ep of episodes) {
    const progress = getProgress('episode', ep.id)
    if (!progress || !progress.watched) return ep
  }
  return null
}
