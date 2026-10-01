import { sep } from 'path'
import { db, encryptValue, decryptValue } from './db'
import { logError } from './errorLog'
import type {
  ActivityItem,
  CastMember,
  ContinueWatchingItem,
  CrewMember,
  Episode,
  IptvChannel,
  IptvHealthSummary,
  Library,
  MediaType,
  Movie,
  MovieMetadataPatch,
  Profile,
  Show,
  ShowMetadataPatch,
  WatchlistItem,
  WatchlistMediaType,
  WatchProgress
} from '../shared/types'
import type { ParsedIptvChannel, ParsedProgramme } from './iptvParser'

/* ---------- row -> type mappers ---------- */

function rowToLibrary(r: any): Library {
  return { id: r.id, path: r.path, type: r.type, name: r.name }
}

function genresToDb(genres: string[] | undefined): string | null {
  return genres && genres.length > 0 ? genres.join(', ') : null
}

function genresFromDb(stored: string | null): string[] {
  return stored ? stored.split(', ').filter(Boolean) : []
}

function castFromDb(stored: string | null): CastMember[] {
  if (!stored) return []
  try {
    return JSON.parse(stored)
  } catch {
    return []
  }
}

function crewFromDb(stored: string | null): CrewMember[] {
  if (!stored) return []
  try {
    return JSON.parse(stored)
  } catch {
    return []
  }
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
    addedAt: r.added_at,
    genres: genresFromDb(r.genres),
    collectionId: r.collection_id,
    collectionName: r.collection_name,
    collectionPosterPath: r.collection_poster_path,
    cast: castFromDb(r.cast_json),
    crew: crewFromDb(r.crew_json),
    trailerKey: r.trailer_key,
    titleLocked: !!r.title_locked
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
    rating: r.rating,
    genres: genresFromDb(r.genres),
    addedAt: r.added_at,
    cast: castFromDb(r.cast_json),
    crew: crewFromDb(r.crew_json),
    trailerKey: r.trailer_key,
    titleLocked: !!r.title_locked
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
    isAdmin: !!r.is_admin,
    hasPin: !!r.pin
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

export function setProfilePin(id: number, pin: string | null): void {
  const stored = pin ? encryptValue(pin) : null
  db.prepare('UPDATE profiles SET pin = ? WHERE id = ?').run(stored, id)
}

export function getProfilePin(id: number): string | null {
  const row = db.prepare('SELECT pin FROM profiles WHERE id = ?').get(id) as
    | { pin: string | null }
    | undefined
  return row?.pin ? decryptValue(row.pin) : null
}

export function verifyProfilePin(id: number, pin: string): boolean {
  const actual = getProfilePin(id)
  return actual !== null && actual === pin
}

// Admin-only: every profile's PIN in cleartext, for oversight/recovery.
// Access control is enforced by the caller (ipc.ts), not here.
export function listProfilesWithPins(): Array<Profile & { pin: string | null }> {
  return listProfiles().map((p) => ({ ...p, pin: getProfilePin(p.id) }))
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
    `INSERT INTO movies (
       library_id, file_path, title, sort_title, year, tmdb_id, overview, poster_path, backdrop_path,
       rating, runtime_minutes, genres, collection_id, collection_name, collection_poster_path,
       cast_json, crew_json, trailer_key
     )
     VALUES (
       @libraryId, @filePath, @title, @sortTitle, @year, @tmdbId, @overview, @posterPath, @backdropPath,
       @rating, @runtimeMinutes, @genres, @collectionId, @collectionName, @collectionPosterPath,
       @castJson, @crewJson, @trailerKey
     )
     ON CONFLICT(file_path) DO UPDATE SET
       title = CASE WHEN title_locked = 0 THEN excluded.title ELSE title END,
       sort_title = CASE WHEN title_locked = 0 THEN excluded.sort_title ELSE sort_title END,
       year = excluded.year,
       tmdb_id = excluded.tmdb_id, overview = excluded.overview, poster_path = excluded.poster_path,
       backdrop_path = excluded.backdrop_path, rating = excluded.rating, runtime_minutes = excluded.runtime_minutes,
       genres = excluded.genres, collection_id = excluded.collection_id,
       collection_name = excluded.collection_name, collection_poster_path = excluded.collection_poster_path,
       cast_json = excluded.cast_json, crew_json = excluded.crew_json, trailer_key = excluded.trailer_key`
  ).run({
    ...m,
    genres: genresToDb(m.genres),
    collectionId: m.collectionId ?? null,
    collectionName: m.collectionName ?? null,
    collectionPosterPath: m.collectionPosterPath ?? null,
    castJson: m.cast && m.cast.length > 0 ? JSON.stringify(m.cast) : null,
    crewJson: m.crew && m.crew.length > 0 ? JSON.stringify(m.crew) : null,
    trailerKey: m.trailerKey ?? null
  } as any)
  return rowToMovie(db.prepare('SELECT * FROM movies WHERE file_path = ?').get(m.filePath))
}

// Called by the scanner for every file it finds on disk — this is scan-only
// bookkeeping, never metadata. It used to reuse upsertMovie, which wrote
// hardcoded nulls for tmdb_id/overview/poster/etc. on *every* rescan and
// then relied on the matcher to immediately re-fill them — so any manual
// correction (a hand-picked TMDb match, an edited title) got silently
// wiped and replaced with whatever the automatic search found next,
// every single time. Once a movie has a tmdb_id, this leaves it alone
// entirely; only genuinely unmatched movies still get title/year refreshed
// from the filename (useful if parsing improves or the file gets renamed).
export function registerMovieFile(m: {
  libraryId: number
  filePath: string
  title: string
  sortTitle: string
  year: number | null
}): Movie {
  db.prepare(
    `INSERT INTO movies (library_id, file_path, title, sort_title, year, tmdb_id, overview, poster_path, backdrop_path, rating, runtime_minutes, genres, collection_id, collection_name, collection_poster_path, cast_json, crew_json, trailer_key)
     VALUES (@libraryId, @filePath, @title, @sortTitle, @year, NULL, NULL, NULL, NULL, NULL, NULL, '', NULL, NULL, NULL, NULL, NULL, NULL)
     ON CONFLICT(file_path) DO UPDATE SET
       title = CASE WHEN tmdb_id IS NULL AND title_locked = 0 THEN excluded.title ELSE title END,
       sort_title = CASE WHEN tmdb_id IS NULL AND title_locked = 0 THEN excluded.sort_title ELSE sort_title END,
       year = CASE WHEN tmdb_id IS NULL AND title_locked = 0 THEN excluded.year ELSE year END`
  ).run(m)
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

// Manual metadata edit (or applying a manually-chosen TMDb match) — unlike
// upsertMovie, this is keyed by id, not the file on disk, and never touches
// filePath/libraryId. Always sets title_locked: registerMovieFile only
// protects a title once tmdb_id is set, so a manual title edit made before
// (or without) an auto-match would otherwise get silently overwritten by the
// filename parser on the very next rescan.
export function updateMovie(id: number, patch: MovieMetadataPatch): Movie {
  const current = getMovie(id)
  if (!current) throw new Error('Movie not found')
  const merged = { ...current, ...patch }
  db.prepare(
    `UPDATE movies SET
       title = @title, sort_title = @sortTitle, year = @year, overview = @overview,
       poster_path = @posterPath, backdrop_path = @backdropPath, rating = @rating,
       runtime_minutes = @runtimeMinutes, tmdb_id = @tmdbId, genres = @genres,
       collection_id = @collectionId, collection_name = @collectionName,
       collection_poster_path = @collectionPosterPath,
       cast_json = @castJson, crew_json = @crewJson, trailer_key = @trailerKey,
       title_locked = 1
     WHERE id = @id`
  ).run({
    id,
    title: merged.title,
    sortTitle: merged.title.replace(/^(the|a|an)\s+/i, '').toLowerCase(),
    year: merged.year,
    overview: merged.overview,
    posterPath: merged.posterPath,
    backdropPath: merged.backdropPath,
    rating: merged.rating,
    runtimeMinutes: merged.runtimeMinutes,
    tmdbId: merged.tmdbId,
    genres: genresToDb(merged.genres),
    collectionId: merged.collectionId,
    collectionName: merged.collectionName,
    collectionPosterPath: merged.collectionPosterPath,
    castJson: merged.cast && merged.cast.length > 0 ? JSON.stringify(merged.cast) : null,
    crewJson: merged.crew && merged.crew.length > 0 ? JSON.stringify(merged.crew) : null,
    trailerKey: merged.trailerKey ?? null
  })
  return getMovie(id)!
}

// Manual removal (Settings/detail-page "Remove from Library"). Deleting the
// file itself, if requested, is the caller's job — this only ever touches
// the DB row.
export function deleteMovie(id: number): void {
  db.prepare('DELETE FROM movies WHERE id = ?').run(id)
}

// A rescan only ever finds and adds files — nothing previously removed a row
// for a file the user deleted from disk. Library-scoped by library_id is
// safe here (unlike episodes below) since movies are never cross-library
// merged.
export function pruneMissingMovies(libraryId: number, foundPaths: Set<string>): number {
  const rows = db.prepare('SELECT id, file_path FROM movies WHERE library_id = ?').all(libraryId) as Array<{
    id: number
    file_path: string
  }>
  const stale = rows.filter((r) => !foundPaths.has(r.file_path))
  // Safety net: a transient read failure (drive hiccup, permissions glitch)
  // can make a scan find far fewer files than actually exist, which would
  // otherwise look identical to "the user deleted most of their library."
  // Refusing to prune when the damage looks anomalous costs nothing — stale
  // entries just wait for the next clean scan — while mass-deleting a
  // library from a fluke is not recoverable from a rescan.
  if (rows.length > 0 && stale.length / rows.length > 0.5) {
    logError(
      'pruneMissingMovies',
      `refusing to prune ${stale.length}/${rows.length} movies in library ${libraryId} — looks anomalous`
    )
    return 0
  }
  const del = db.prepare('DELETE FROM movies WHERE id = ?')
  for (const row of stale) del.run(row.id)
  return stale.length
}

/* ---------- shows / episodes ---------- */

export function upsertShow(s: Omit<Show, 'id' | 'addedAt'>): Show {
  db.prepare(
    `INSERT INTO shows (library_id, folder_path, title, sort_title, year, tmdb_id, overview, poster_path, backdrop_path, rating, genres, cast_json, crew_json, trailer_key)
     VALUES (@libraryId, @folderPath, @title, @sortTitle, @year, @tmdbId, @overview, @posterPath, @backdropPath, @rating, @genres, @castJson, @crewJson, @trailerKey)
     ON CONFLICT(folder_path) DO UPDATE SET
       title = CASE WHEN title_locked = 0 THEN excluded.title ELSE title END,
       sort_title = CASE WHEN title_locked = 0 THEN excluded.sort_title ELSE sort_title END,
       year = excluded.year,
       tmdb_id = excluded.tmdb_id, overview = excluded.overview, poster_path = excluded.poster_path,
       backdrop_path = excluded.backdrop_path, rating = excluded.rating, genres = excluded.genres,
       cast_json = excluded.cast_json, crew_json = excluded.crew_json, trailer_key = excluded.trailer_key`
  ).run({
    ...s,
    genres: genresToDb(s.genres),
    castJson: s.cast && s.cast.length > 0 ? JSON.stringify(s.cast) : null,
    crewJson: s.crew && s.crew.length > 0 ? JSON.stringify(s.crew) : null,
    trailerKey: s.trailerKey ?? null
  } as any)
  return rowToShow(db.prepare('SELECT * FROM shows WHERE folder_path = ?').get(s.folderPath))
}

// Cross-library lookup used by the scanner so a show found while scanning
// one library (e.g. a season folder on D:) can be folded into a show that
// already exists from a different library (e.g. the same series' other
// seasons on E:) instead of creating a duplicate per drive.
export function findShowByTitle(title: string): Show | null {
  const row = db
    .prepare(
      'SELECT * FROM shows WHERE lower(title) = lower(?) AND merged_into_id IS NULL ORDER BY id LIMIT 1'
    )
    .get(title)
  return row ? rowToShow(row) : null
}

// Two folders can carry different partial/garbled titles (e.g. a subtitle
// present in one release's name but missing from another) and still both
// correctly resolve to the same TMDb entry — the tmdb_id is a much more
// reliable identity than the parsed title string once a match exists.
export function findShowByTmdbId(tmdbId: number): Show | null {
  const row = db
    .prepare('SELECT * FROM shows WHERE tmdb_id = ? AND merged_into_id IS NULL ORDER BY id LIMIT 1')
    .get(tmdbId)
  return row ? rowToShow(row) : null
}

// Primary lookup for the scanner: folder_path is stable across rescans, unlike
// a freshly re-parsed title, which drifts away from the DB row's title the
// moment that show gets TMDb-matched or manually renamed. Checking every dir
// in the group (not just the representative one) covers season-per-folder
// releases where the "representative" dir can vary between scans.
//
// A matched row may be a tombstone left behind by mergeShows/foldShowFolderPath
// (merged_into_id set) rather than a live show — follow that redirect chain
// so a rescan of a merged-away folder lands back on the show it was folded
// into instead of resurrecting it as a fresh duplicate.
export function findShowByFolderPathAny(folderPaths: string[]): Show | null {
  if (folderPaths.length === 0) return null
  const placeholders = folderPaths.map(() => '?').join(',')
  let row = db
    .prepare(`SELECT * FROM shows WHERE folder_path IN (${placeholders}) ORDER BY id LIMIT 1`)
    .get(...folderPaths) as any
  while (row && row.merged_into_id != null) {
    row = db.prepare('SELECT * FROM shows WHERE id = ?').get(row.merged_into_id)
  }
  return row ? rowToShow(row) : null
}

export function listShows(libraryId?: number): Show[] {
  const rows = libraryId
    ? db
        .prepare(
          'SELECT * FROM shows WHERE library_id = ? AND merged_into_id IS NULL ORDER BY sort_title'
        )
        .all(libraryId)
    : db.prepare('SELECT * FROM shows WHERE merged_into_id IS NULL ORDER BY sort_title').all()
  return (rows as any[]).map(rowToShow)
}

export function getShow(id: number): Show | null {
  const row = db.prepare('SELECT * FROM shows WHERE id = ?').get(id)
  return row ? rowToShow(row) : null
}

// Manual metadata edit (or applying a manually-chosen TMDb match) — always
// sets title_locked so a future rescan's automatic re-match step
// (scanAndMatchLibrary's `!show.tmdbId` re-search) never overwrites it, even
// for a show that was edited without ever getting a tmdb_id.
export function updateShow(id: number, patch: ShowMetadataPatch): Show {
  const current = getShow(id)
  if (!current) throw new Error('Show not found')
  const merged = { ...current, ...patch }
  db.prepare(
    `UPDATE shows SET
       title = @title, sort_title = @sortTitle, year = @year, overview = @overview,
       poster_path = @posterPath, backdrop_path = @backdropPath, rating = @rating, tmdb_id = @tmdbId,
       genres = @genres, cast_json = @castJson, crew_json = @crewJson, trailer_key = @trailerKey,
       title_locked = 1
     WHERE id = @id`
  ).run({
    id,
    title: merged.title,
    sortTitle: merged.title.replace(/^(the|a|an)\s+/i, '').toLowerCase(),
    year: merged.year,
    overview: merged.overview,
    posterPath: merged.posterPath,
    backdropPath: merged.backdropPath,
    rating: merged.rating,
    tmdbId: merged.tmdbId,
    genres: genresToDb(merged.genres),
    castJson: merged.cast && merged.cast.length > 0 ? JSON.stringify(merged.cast) : null,
    crewJson: merged.crew && merged.crew.length > 0 ? JSON.stringify(merged.crew) : null,
    trailerKey: merged.trailerKey ?? null
  })
  return getShow(id)!
}

// Manual removal (Settings/detail-page "Remove from Library"). Episodes
// cascade via the FK (episodes.show_id ON DELETE CASCADE) — deleting the
// underlying files themselves, if requested, is the caller's job.
export function deleteShow(id: number): void {
  db.prepare('DELETE FROM shows WHERE id = ?').run(id)
}

// A rescan only ever finds and adds files — nothing previously removed a row
// for a file the user deleted from disk. Scoped by the library's own root
// *path* rather than show.library_id: cross-library merges (findShowByTitle)
// mean a show's episodes can legitimately span multiple libraries/drives, so
// filtering by show.library_id would wrongly delete episodes that live on a
// different, currently-untouched drive just because the merged show's own
// library_id happens to point elsewhere.
export function pruneMissingEpisodes(libraryRootPath: string, foundPaths: Set<string>): number {
  const prefix = libraryRootPath.endsWith(sep) ? libraryRootPath : libraryRootPath + sep
  const rows = db.prepare('SELECT id, show_id, file_path FROM episodes').all() as Array<{
    id: number
    show_id: number
    file_path: string
  }>
  const inLibrary = rows.filter((r) => r.file_path.startsWith(prefix))
  const stale = inLibrary.filter((r) => !foundPaths.has(r.file_path))
  // Same anomalous-scan safety net as pruneMissingMovies.
  if (inLibrary.length > 0 && stale.length / inLibrary.length > 0.5) {
    logError(
      'pruneMissingEpisodes',
      `refusing to prune ${stale.length}/${inLibrary.length} episodes under ${libraryRootPath} — looks anomalous`
    )
    return 0
  }
  if (stale.length === 0) return 0

  const delEpisode = db.prepare('DELETE FROM episodes WHERE id = ?')
  const affectedShowIds = new Set<number>()
  for (const row of stale) {
    delEpisode.run(row.id)
    affectedShowIds.add(row.show_id)
  }

  // A show whose every episode just got pruned (its only season deleted from
  // disk) shouldn't linger as an empty entry.
  const countEpisodes = db.prepare('SELECT COUNT(*) AS c FROM episodes WHERE show_id = ?')
  const delShow = db.prepare('DELETE FROM shows WHERE id = ?')
  for (const showId of affectedShowIds) {
    const remaining = (countEpisodes.get(showId) as { c: number }).c
    if (remaining === 0) delShow.run(showId)
  }

  return stale.length
}

// Manual fixup for shows the scanner couldn't merge on its own (different
// titles/spellings entirely). Moves every episode from each source show
// onto the target show, then tombstones the now-empty source shows.
export function mergeShows(targetId: number, sourceIds: number[]): Show {
  const target = getShow(targetId)
  if (!target) throw new Error('Target show not found')

  const tx = db.transaction(() => {
    for (const sourceId of sourceIds) {
      if (sourceId === targetId) continue
      const episodes = db
        .prepare('SELECT id, season_number, episode_number FROM episodes WHERE show_id = ?')
        .all(sourceId) as Array<{ id: number; season_number: number; episode_number: number }>

      for (const ep of episodes) {
        // Same slot-collision guard as upsertEpisode: if the target show
        // already has an episode in that season/episode slot, leave this
        // one where it is rather than crash on the unique constraint.
        const collision = db
          .prepare(
            'SELECT id FROM episodes WHERE show_id = ? AND season_number = ? AND episode_number = ? AND id != ?'
          )
          .get(targetId, ep.season_number, ep.episode_number, ep.id)
        if (!collision) {
          db.prepare('UPDATE episodes SET show_id = ? WHERE id = ?').run(targetId, ep.id)
        }
      }

      // Tombstone rather than delete: a rescan re-derives show groupings
      // straight from folder/file names on disk, with no memory of this
      // merge — without a redirect left behind, the very next rescan would
      // recreate this source show from its still-present folder and pull
      // the episodes right back off the target, silently undoing the merge.
      // Flatten first so anything already redirecting into this source
      // (an earlier merge) points straight at the new target instead of
      // chaining through it.
      db.prepare('UPDATE shows SET merged_into_id = ? WHERE merged_into_id = ?').run(
        targetId,
        sourceId
      )
      db.prepare('UPDATE shows SET merged_into_id = ? WHERE id = ?').run(targetId, sourceId)
    }
  })
  tx()

  return getShow(targetId)!
}

export function upsertEpisode(e: Omit<Episode, 'id'>): Episode {
  const byPath = db.prepare('SELECT id FROM episodes WHERE file_path = ?').get(e.filePath) as
    | { id: number }
    | undefined
  if (byPath) {
    // Reassigning this row's show/season/episode (e.g. a show merge) could
    // collide with a *different* existing row claiming that same slot.
    // When it would, only refresh the metadata fields and leave the
    // show/season/episode assignment as-is rather than crash the scan.
    const collision = db
      .prepare(
        'SELECT id FROM episodes WHERE show_id = ? AND season_number = ? AND episode_number = ? AND id != ?'
      )
      .get(e.showId, e.seasonNumber, e.episodeNumber, byPath.id) as { id: number } | undefined

    if (collision) {
      db.prepare(
        `UPDATE episodes SET
           title = @title, overview = @overview, still_path = @stillPath,
           air_date = @airDate, duration_seconds = @durationSeconds
         WHERE id = @id`
      ).run({ ...e, id: byPath.id } as any)
    } else {
      db.prepare(
        `UPDATE episodes SET
           show_id = @showId, season_number = @seasonNumber, episode_number = @episodeNumber,
           title = @title, overview = @overview, still_path = @stillPath,
           air_date = @airDate, duration_seconds = @durationSeconds
         WHERE id = @id`
      ).run({ ...e, id: byPath.id } as any)
    }
    return rowToEpisode(db.prepare('SELECT * FROM episodes WHERE id = ?').get(byPath.id))
  }

  // Another file may already occupy this show's season/episode slot — e.g. a
  // duplicate release or a multi-episode file whose regex only captured the
  // first episode number. Keep the existing row rather than crash on the
  // (show_id, season_number, episode_number) unique constraint.
  const bySeasonEpisode = db
    .prepare('SELECT id FROM episodes WHERE show_id = ? AND season_number = ? AND episode_number = ?')
    .get(e.showId, e.seasonNumber, e.episodeNumber) as { id: number } | undefined
  if (bySeasonEpisode) {
    return rowToEpisode(db.prepare('SELECT * FROM episodes WHERE id = ?').get(bySeasonEpisode.id))
  }

  db.prepare(
    `INSERT INTO episodes (show_id, season_number, episode_number, file_path, title, overview, still_path, air_date, duration_seconds)
     VALUES (@showId, @seasonNumber, @episodeNumber, @filePath, @title, @overview, @stillPath, @airDate, @durationSeconds)`
  ).run(e as any)
  return rowToEpisode(db.prepare('SELECT * FROM episodes WHERE file_path = ?').get(e.filePath))
}

// Called by the scanner for every episode file it finds — scan-only
// bookkeeping (which show/season/episode this file belongs to), never
// metadata. It used to reuse upsertEpisode, which wrote hardcoded nulls for
// overview/still_path/air_date/duration on *every* rescan, wiping whatever
// the matcher had already filled in each time. Uses overview IS NULL as the
// "not yet matched" signal (no separate per-episode flag exists) — once an
// episode has real matched data, this never touches its content again, only
// keeping the show/season/episode assignment current (needed for merges).
export function registerEpisodeFile(e: {
  showId: number
  seasonNumber: number
  episodeNumber: number
  filePath: string
  fallbackTitle: string
}): Episode {
  const byPath = db.prepare('SELECT id, overview FROM episodes WHERE file_path = ?').get(e.filePath) as
    | { id: number; overview: string | null }
    | undefined
  if (byPath) {
    const collision = db
      .prepare(
        'SELECT id FROM episodes WHERE show_id = ? AND season_number = ? AND episode_number = ? AND id != ?'
      )
      .get(e.showId, e.seasonNumber, e.episodeNumber, byPath.id) as { id: number } | undefined

    if (!collision) {
      if (byPath.overview === null) {
        db.prepare(
          `UPDATE episodes SET
             show_id = @showId, season_number = @seasonNumber, episode_number = @episodeNumber,
             title = @fallbackTitle
           WHERE id = @id`
        ).run({ ...e, id: byPath.id })
      } else {
        db.prepare(
          `UPDATE episodes SET show_id = @showId, season_number = @seasonNumber, episode_number = @episodeNumber
           WHERE id = @id`
        ).run({
          showId: e.showId,
          seasonNumber: e.seasonNumber,
          episodeNumber: e.episodeNumber,
          id: byPath.id
        })
      }
    }
    return rowToEpisode(db.prepare('SELECT * FROM episodes WHERE id = ?').get(byPath.id))
  }

  const bySeasonEpisode = db
    .prepare('SELECT id FROM episodes WHERE show_id = ? AND season_number = ? AND episode_number = ?')
    .get(e.showId, e.seasonNumber, e.episodeNumber) as { id: number } | undefined
  if (bySeasonEpisode) {
    return rowToEpisode(db.prepare('SELECT * FROM episodes WHERE id = ?').get(bySeasonEpisode.id))
  }

  db.prepare(
    `INSERT INTO episodes (show_id, season_number, episode_number, file_path, title, overview, still_path, air_date, duration_seconds)
     VALUES (@showId, @seasonNumber, @episodeNumber, @filePath, @fallbackTitle, NULL, NULL, NULL, NULL)`
  ).run(e)
  return rowToEpisode(db.prepare('SELECT * FROM episodes WHERE file_path = ?').get(e.filePath))
}

// Used by the scanner when this scan's title-based grouping folds a folder
// into a show whose canonical row lives at a different folder_path (e.g. two
// release folders that now parse to the same title, or a folder already
// merged in via mergeShows). Tombstones rather than deletes, for the same
// reason mergeShows does — so the fold sticks on every future rescan instead
// of the loser folder resurrecting itself as a fresh duplicate the next time
// it's walked.
export function foldShowFolderPath(folderPath: string, targetId: number): void {
  db.prepare('UPDATE shows SET merged_into_id = ? WHERE folder_path = ? AND id != ?').run(
    targetId,
    folderPath,
    targetId
  )
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

/* ---------- search & discovery ---------- */

export interface LibrarySearchResults {
  movies: Movie[]
  shows: Show[]
}

export function searchLibrary(query: string): LibrarySearchResults {
  const like = `%${query}%`
  const movies = (
    db
      .prepare('SELECT * FROM movies WHERE title LIKE ? ORDER BY sort_title LIMIT 25')
      .all(like) as any[]
  ).map(rowToMovie)
  const shows = (
    db
      .prepare(
        'SELECT * FROM shows WHERE title LIKE ? AND merged_into_id IS NULL ORDER BY sort_title LIMIT 25'
      )
      .all(like) as any[]
  ).map(rowToShow)
  return { movies, shows }
}

// "More Like This" only makes sense for titles the user actually owns —
// cross-reference TMDb's recommended ids against the local library.
export function getMoviesByTmdbIds(tmdbIds: number[]): Movie[] {
  if (tmdbIds.length === 0) return []
  const placeholders = tmdbIds.map(() => '?').join(',')
  return (
    db.prepare(`SELECT * FROM movies WHERE tmdb_id IN (${placeholders})`).all(...tmdbIds) as any[]
  ).map(rowToMovie)
}

export function getShowsByTmdbIds(tmdbIds: number[]): Show[] {
  if (tmdbIds.length === 0) return []
  const placeholders = tmdbIds.map(() => '?').join(',')
  return (
    db
      .prepare(
        `SELECT * FROM shows WHERE tmdb_id IN (${placeholders}) AND merged_into_id IS NULL`
      )
      .all(...tmdbIds) as any[]
  ).map(rowToShow)
}

export function getMoviesInCollection(collectionId: number, excludeMovieId: number): Movie[] {
  return (
    db
      .prepare('SELECT * FROM movies WHERE collection_id = ? AND id != ? ORDER BY year')
      .all(collectionId, excludeMovieId) as any[]
  ).map(rowToMovie)
}

/* ---------- watch progress ---------- */

// pin is unused here — a local call is already implicitly trusted (same
// machine, same Electron process). It exists only so this keeps the same
// call signature as remoteClient.ts's version, which does check it, so
// dataSource() can dispatch to either uniformly.
export function saveProgress(
  profileId: number,
  mediaType: MediaType,
  mediaId: number,
  positionSeconds: number,
  durationSeconds: number,
  _pin?: string | null
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
  mediaId: number,
  _pin?: string | null
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
  watched: boolean,
  _pin?: string | null
): void {
  db.prepare(
    `INSERT INTO watch_progress (profile_id, media_type, media_id, position_seconds, duration_seconds, watched, updated_at)
     VALUES (?, ?, 0, 0, ?, datetime('now'))
     ON CONFLICT(profile_id, media_type, media_id) DO UPDATE SET watched = excluded.watched, updated_at = excluded.updated_at`
  ).run(profileId, mediaType, mediaId, watched ? 1 : 0)
}

export function getContinueWatching(
  profileId: number,
  limit = 20,
  _pin?: string | null
): ContinueWatchingItem[] {
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

function rowToIptvChannel(
  r: any
): Omit<
  IptvChannel,
  'nowPlayingTitle' | 'nowPlayingStartsAt' | 'nowPlayingEndsAt' | 'nextProgrammeTitle' | 'nextProgrammeStartsAt'
> {
  return {
    id: r.id,
    tvgId: r.tvg_id,
    name: r.name,
    logoUrl: r.logo_url,
    groupTitle: r.group_title,
    sortOrder: r.sort_order,
    isDead: !!r.is_dead,
    checkedAt: r.checked_at
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
      'SELECT channel_tvg_id, title, start_at, stop_at FROM iptv_programmes WHERE start_at <= ? AND stop_at > ?'
    )
    .all(nowIso, nowIso) as any[]
  const nowByChannel = new Map(airing.map((r) => [r.channel_tvg_id, r]))

  // One row per channel: its soonest programme that hasn't started yet.
  // Fetched as a flat, already-time-ordered list and reduced in JS (first
  // match per channel wins) rather than a correlated subquery per channel.
  const upcoming = db
    .prepare(
      'SELECT channel_tvg_id, title, start_at FROM iptv_programmes WHERE start_at > ? ORDER BY channel_tvg_id, start_at ASC'
    )
    .all(nowIso) as any[]
  const nextByChannel = new Map<string, any>()
  for (const row of upcoming) {
    if (!nextByChannel.has(row.channel_tvg_id)) nextByChannel.set(row.channel_tvg_id, row)
  }

  return channels.map((c) => {
    const nowPlaying = c.tvgId ? nowByChannel.get(c.tvgId) : undefined
    const next = c.tvgId ? nextByChannel.get(c.tvgId) : undefined
    return {
      ...c,
      nowPlayingTitle: nowPlaying?.title ?? null,
      nowPlayingStartsAt: nowPlaying?.start_at ?? null,
      nowPlayingEndsAt: nowPlaying?.stop_at ?? null,
      nextProgrammeTitle: next?.title ?? null,
      nextProgrammeStartsAt: next?.start_at ?? null
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

// Internal only — same stream_url confidentiality rule as above. Used
// exclusively by the background channel-health checker.
export function listIptvChannelsForHealthCheck(): Array<{ id: number; streamUrl: string }> {
  return (db.prepare('SELECT id, stream_url FROM iptv_channels').all() as Array<{
    id: number
    stream_url: string
  }>).map((r) => ({ id: r.id, streamUrl: r.stream_url }))
}

export function setIptvChannelHealth(id: number, isDead: boolean): void {
  db.prepare('UPDATE iptv_channels SET is_dead = ?, checked_at = ? WHERE id = ?').run(
    isDead ? 1 : 0,
    new Date().toISOString(),
    id
  )
}

export function getIptvHealthSummary(): IptvHealthSummary {
  const row = db
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN checked_at IS NOT NULL THEN 1 ELSE 0 END) as checked,
              SUM(CASE WHEN is_dead = 1 THEN 1 ELSE 0 END) as dead
       FROM iptv_channels`
    )
    .get() as { total: number; checked: number | null; dead: number | null }
  return {
    total: row.total,
    checked: row.checked ?? 0,
    dead: row.dead ?? 0,
    running: false
  }
}

/* ---------- watchlist ---------- */

function rowToWatchlistItem(r: any): WatchlistItem {
  return {
    mediaType: r.media_type,
    mediaId: r.media_id,
    addedAt: r.added_at,
    title: r.title,
    year: r.year,
    posterPath: r.poster_path
  }
}

// Trailing `_pin` on these is unused locally — it exists purely so this
// signature matches remoteClient.ts's (which needs the PIN to reach the
// host's PIN-gated HTTP endpoint), letting ipc.ts's dataSource() call either
// module interchangeably without branching on remoteAccessMode.
export function listWatchlist(profileId: number, _pin?: string | null): WatchlistItem[] {
  const rows = db
    .prepare('SELECT media_type, media_id, added_at FROM watchlist WHERE profile_id = ? ORDER BY added_at DESC')
    .all(profileId) as Array<{ media_type: WatchlistMediaType; media_id: number; added_at: string }>

  const items: WatchlistItem[] = []
  for (const row of rows) {
    if (row.media_type === 'movie') {
      const movie = getMovie(row.media_id)
      if (!movie) continue
      items.push({
        mediaType: 'movie',
        mediaId: movie.id,
        addedAt: row.added_at,
        title: movie.title,
        year: movie.year,
        posterPath: movie.posterPath
      })
    } else {
      const show = getShow(row.media_id)
      if (!show) continue
      items.push({
        mediaType: 'show',
        mediaId: show.id,
        addedAt: row.added_at,
        title: show.title,
        year: show.year,
        posterPath: show.posterPath
      })
    }
  }
  return items
}

export function isInWatchlist(
  profileId: number,
  mediaType: WatchlistMediaType,
  mediaId: number,
  _pin?: string | null
): boolean {
  const row = db
    .prepare('SELECT 1 FROM watchlist WHERE profile_id = ? AND media_type = ? AND media_id = ?')
    .get(profileId, mediaType, mediaId)
  return !!row
}

export function addToWatchlist(
  profileId: number,
  mediaType: WatchlistMediaType,
  mediaId: number,
  _pin?: string | null
): void {
  db.prepare(
    'INSERT OR IGNORE INTO watchlist (profile_id, media_type, media_id) VALUES (?, ?, ?)'
  ).run(profileId, mediaType, mediaId)
}

export function removeFromWatchlist(
  profileId: number,
  mediaType: WatchlistMediaType,
  mediaId: number,
  _pin?: string | null
): void {
  db.prepare('DELETE FROM watchlist WHERE profile_id = ? AND media_type = ? AND media_id = ?').run(
    profileId,
    mediaType,
    mediaId
  )
}

/* ---------- "new since last visit" ---------- */

export function getLibrarySeenAt(
  profileId: number,
  _pin?: string | null
): { movies: string | null; shows: string | null } {
  const row = db.prepare('SELECT movies_seen_at, shows_seen_at FROM profiles WHERE id = ?').get(
    profileId
  ) as { movies_seen_at: string | null; shows_seen_at: string | null } | undefined
  return { movies: row?.movies_seen_at ?? null, shows: row?.shows_seen_at ?? null }
}

export function markLibrarySeen(
  profileId: number,
  mediaType: 'movie' | 'show',
  _pin?: string | null
): void {
  const column = mediaType === 'movie' ? 'movies_seen_at' : 'shows_seen_at'
  db.prepare(`UPDATE profiles SET ${column} = ? WHERE id = ?`).run(new Date().toISOString(), profileId)
}
