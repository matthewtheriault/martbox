import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, existsSync, writeFileSync } from 'fs'
import { getSetting } from './db'
import type { CastMember, CrewMember } from '../shared/types'

const TMDB_API = 'https://api.themoviedb.org/3'
const IMAGE_BASE = 'https://image.tmdb.org/t/p'

const imageCacheDir = join(app.getPath('userData'), 'images-cache')
mkdirSync(imageCacheDir, { recursive: true })

function apiKey(): string | null {
  return getSetting('tmdbApiKey')
}

let lastRequestAt = 0
async function throttle(): Promise<void> {
  const minGapMs = 260
  const wait = lastRequestAt + minGapMs - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt = Date.now()
}

async function tmdbGet<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
  const key = apiKey()
  if (!key) return null
  await throttle()
  const url = new URL(TMDB_API + path)
  url.searchParams.set('api_key', key)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString())
  if (!res.ok) return null
  return (await res.json()) as T
}

export async function testApiKey(key: string): Promise<boolean> {
  const res = await fetch(`${TMDB_API}/configuration?api_key=${encodeURIComponent(key)}`)
  return res.ok
}

interface TmdbMovieSearchResult {
  id: number
  title: string
  release_date: string | null
  overview: string
  poster_path: string | null
  backdrop_path: string | null
  vote_average: number
}

interface TmdbTvSearchResult {
  id: number
  name: string
  first_air_date: string | null
  overview: string
  poster_path: string | null
  backdrop_path: string | null
  vote_average: number
}

export interface MovieMatch {
  tmdbId: number
  title: string
  year: number | null
  overview: string
  posterPath: string | null
  backdropPath: string | null
  rating: number
  runtimeMinutes: number | null
  genres: string[]
  collectionId: number | null
  collectionName: string | null
  collectionPosterPath: string | null
  cast: CastMember[]
  crew: CrewMember[]
  trailerKey: string | null
}

export interface ShowMatch {
  tmdbId: number
  title: string
  year: number | null
  overview: string
  posterPath: string | null
  backdropPath: string | null
  rating: number
  genres: string[]
  cast: CastMember[]
  crew: CrewMember[]
  trailerKey: string | null
}

interface TmdbCastMember {
  name: string
  character: string
  profile_path: string | null
  order: number
}

interface TmdbCrewMember {
  name: string
  job: string
}

interface TmdbVideo {
  key: string
  site: string
  type: string
  official: boolean
}

function extractCast(credits: { cast?: TmdbCastMember[] } | undefined): CastMember[] {
  return (credits?.cast ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .slice(0, 12)
    .map((c) => ({ name: c.name, character: c.character, profilePath: c.profile_path }))
}

// Director for movies, creator-equivalent (show runner) for shows — callers
// pass whichever job title(s) apply and get back just the matching crew.
function extractCrew(credits: { crew?: TmdbCrewMember[] } | undefined, jobs: string[]): CrewMember[] {
  const seen = new Set<string>()
  const result: CrewMember[] = []
  for (const c of credits?.crew ?? []) {
    if (!jobs.includes(c.job) || seen.has(c.name)) continue
    seen.add(c.name)
    result.push({ name: c.name, job: c.job })
  }
  return result
}

function extractTrailerKey(videos: { results?: TmdbVideo[] } | undefined): string | null {
  const results = videos?.results ?? []
  const trailers = results.filter((v) => v.site === 'YouTube' && v.type === 'Trailer')
  return (trailers.find((v) => v.official) ?? trailers[0])?.key ?? null
}

export interface EpisodeMatch {
  seasonNumber: number
  episodeNumber: number
  title: string
  overview: string | null
  stillPath: string | null
  airDate: string | null
}

async function cacheImage(tmdbPath: string, size: 'w500' | 'w1280' | 'w300'): Promise<string | null> {
  const filename = `${size}_${tmdbPath.replace(/^\//, '')}`
  const dest = join(imageCacheDir, filename)
  if (existsSync(dest)) return dest
  try {
    const res = await fetch(`${IMAGE_BASE}/${size}${tmdbPath}`)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(dest, buf)
    return dest
  } catch {
    return null
  }
}

interface TmdbGenre {
  id: number
  name: string
}

interface TmdbCollection {
  id: number
  name: string
  poster_path: string | null
}

async function resolveCollection(collection: TmdbCollection | null | undefined): Promise<{
  collectionId: number | null
  collectionName: string | null
  collectionPosterPath: string | null
}> {
  if (!collection) return { collectionId: null, collectionName: null, collectionPosterPath: null }
  const collectionPosterPath = collection.poster_path
    ? await cacheImage(collection.poster_path, 'w300')
    : null
  return { collectionId: collection.id, collectionName: collection.name, collectionPosterPath }
}

export async function matchMovie(title: string, year: number | null): Promise<MovieMatch | null> {
  let results = await tmdbGet<{ results: TmdbMovieSearchResult[] }>('/search/movie', {
    query: title,
    ...(year ? { year: String(year) } : {})
  })
  // A year parsed from the filename (or misread from something else) can be
  // off by a year or two from TMDb's actual release year, and search treats
  // it as a hard filter — that turns an otherwise-easy match into zero
  // results. Retry unfiltered before giving up.
  if (year && !results?.results?.length) {
    results = await tmdbGet<{ results: TmdbMovieSearchResult[] }>('/search/movie', { query: title })
  }
  const best = results?.results?.[0]
  if (!best) return null

  const details = await tmdbGet<{
    runtime: number | null
    genres: TmdbGenre[]
    belongs_to_collection: TmdbCollection | null
    credits?: { cast?: TmdbCastMember[]; crew?: TmdbCrewMember[] }
    videos?: { results?: TmdbVideo[] }
  }>(`/movie/${best.id}`, { append_to_response: 'credits,videos' })

  const posterPath = best.poster_path ? await cacheImage(best.poster_path, 'w500') : null
  const backdropPath = best.backdrop_path ? await cacheImage(best.backdrop_path, 'w1280') : null
  const collection = await resolveCollection(details?.belongs_to_collection)

  return {
    tmdbId: best.id,
    title: best.title,
    year: best.release_date ? parseInt(best.release_date.slice(0, 4), 10) : null,
    overview: best.overview,
    posterPath,
    backdropPath,
    rating: best.vote_average,
    runtimeMinutes: details?.runtime ?? null,
    genres: (details?.genres ?? []).map((g) => g.name),
    ...collection,
    cast: extractCast(details?.credits),
    crew: extractCrew(details?.credits, ['Director']),
    trailerKey: extractTrailerKey(details?.videos)
  }
}

export async function matchShow(title: string, year: number | null): Promise<ShowMatch | null> {
  let results = await tmdbGet<{ results: TmdbTvSearchResult[] }>('/search/tv', {
    query: title,
    ...(year ? { first_air_date_year: String(year) } : {})
  })
  // Same reasoning as matchMovie: a filename-derived year is a soft signal,
  // not a guarantee — a show's actual first-air-date year can easily differ
  // from what's in the folder name. Don't let a wrong year zero out an
  // otherwise-unambiguous title match.
  if (year && !results?.results?.length) {
    results = await tmdbGet<{ results: TmdbTvSearchResult[] }>('/search/tv', { query: title })
  }
  const best = results?.results?.[0]
  if (!best) return null

  const details = await tmdbGet<{
    genres: TmdbGenre[]
    created_by?: Array<{ name: string }>
    credits?: { cast?: TmdbCastMember[]; crew?: TmdbCrewMember[] }
    videos?: { results?: TmdbVideo[] }
  }>(`/tv/${best.id}`, { append_to_response: 'credits,videos' })

  const posterPath = best.poster_path ? await cacheImage(best.poster_path, 'w500') : null
  const backdropPath = best.backdrop_path ? await cacheImage(best.backdrop_path, 'w1280') : null
  // TV shows carry their creator(s) as a dedicated top-level field, not a
  // "Creator" job in the crew list (that's a movie-only concept there) —
  // fall back to Executive Producer crew only if TMDb has no creator on file.
  const creators: CrewMember[] =
    details?.created_by && details.created_by.length > 0
      ? details.created_by.map((c) => ({ name: c.name, job: 'Creator' }))
      : extractCrew(details?.credits, ['Executive Producer'])

  return {
    tmdbId: best.id,
    title: best.name,
    year: best.first_air_date ? parseInt(best.first_air_date.slice(0, 4), 10) : null,
    overview: best.overview,
    posterPath,
    backdropPath,
    rating: best.vote_average,
    genres: (details?.genres ?? []).map((g) => g.name),
    cast: extractCast(details?.credits),
    crew: creators,
    trailerKey: extractTrailerKey(details?.videos)
  }
}

export interface MovieSearchResult {
  tmdbId: number
  title: string
  year: number | null
  overview: string
  posterPath: string | null
}

export interface ShowSearchResult {
  tmdbId: number
  title: string
  year: number | null
  overview: string
  posterPath: string | null
}

// Search results return the raw TMDb poster path (unc­ached) — the renderer
// previews these directly from image.tmdb.org, since most results are never
// picked and caching all of them would be wasted downloads.
export async function searchMovies(query: string): Promise<MovieSearchResult[]> {
  const results = await tmdbGet<{ results: TmdbMovieSearchResult[] }>('/search/movie', { query })
  return (results?.results ?? []).slice(0, 12).map((r) => ({
    tmdbId: r.id,
    title: r.title,
    year: r.release_date ? parseInt(r.release_date.slice(0, 4), 10) : null,
    overview: r.overview,
    posterPath: r.poster_path
  }))
}

export async function searchShows(query: string): Promise<ShowSearchResult[]> {
  const results = await tmdbGet<{ results: TmdbTvSearchResult[] }>('/search/tv', { query })
  return (results?.results ?? []).slice(0, 12).map((r) => ({
    tmdbId: r.id,
    title: r.name,
    year: r.first_air_date ? parseInt(r.first_air_date.slice(0, 4), 10) : null,
    overview: r.overview,
    posterPath: r.poster_path
  }))
}

// Fetch full details for a specific TMDb id, chosen manually by the user
// (e.g. from searchMovies/searchShows results) rather than the best guess
// from a title search — used to fix a wrong or missing auto-match.
export async function fetchMovieByTmdbId(tmdbId: number): Promise<MovieMatch | null> {
  const details = await tmdbGet<{
    id: number
    title: string
    release_date: string | null
    overview: string
    poster_path: string | null
    backdrop_path: string | null
    vote_average: number
    runtime: number | null
    genres: TmdbGenre[]
    belongs_to_collection: TmdbCollection | null
    credits?: { cast?: TmdbCastMember[]; crew?: TmdbCrewMember[] }
    videos?: { results?: TmdbVideo[] }
  }>(`/movie/${tmdbId}`, { append_to_response: 'credits,videos' })
  if (!details) return null

  const posterPath = details.poster_path ? await cacheImage(details.poster_path, 'w500') : null
  const backdropPath = details.backdrop_path ? await cacheImage(details.backdrop_path, 'w1280') : null
  const collection = await resolveCollection(details.belongs_to_collection)

  return {
    tmdbId: details.id,
    title: details.title,
    year: details.release_date ? parseInt(details.release_date.slice(0, 4), 10) : null,
    overview: details.overview,
    posterPath,
    backdropPath,
    rating: details.vote_average,
    runtimeMinutes: details.runtime,
    genres: (details.genres ?? []).map((g) => g.name),
    ...collection,
    cast: extractCast(details.credits),
    crew: extractCrew(details.credits, ['Director']),
    trailerKey: extractTrailerKey(details.videos)
  }
}

export async function fetchShowByTmdbId(tmdbId: number): Promise<ShowMatch | null> {
  const details = await tmdbGet<{
    id: number
    name: string
    first_air_date: string | null
    overview: string
    poster_path: string | null
    backdrop_path: string | null
    vote_average: number
    genres: TmdbGenre[]
    created_by?: Array<{ name: string }>
    credits?: { cast?: TmdbCastMember[]; crew?: TmdbCrewMember[] }
    videos?: { results?: TmdbVideo[] }
  }>(`/tv/${tmdbId}`, { append_to_response: 'credits,videos' })
  if (!details) return null

  const posterPath = details.poster_path ? await cacheImage(details.poster_path, 'w500') : null
  const backdropPath = details.backdrop_path ? await cacheImage(details.backdrop_path, 'w1280') : null
  const creators: CrewMember[] =
    details.created_by && details.created_by.length > 0
      ? details.created_by.map((c) => ({ name: c.name, job: 'Creator' }))
      : extractCrew(details.credits, ['Executive Producer'])

  return {
    tmdbId: details.id,
    title: details.name,
    year: details.first_air_date ? parseInt(details.first_air_date.slice(0, 4), 10) : null,
    overview: details.overview,
    posterPath,
    backdropPath,
    rating: details.vote_average,
    genres: (details.genres ?? []).map((g) => g.name),
    cast: extractCast(details.credits),
    crew: creators,
    trailerKey: extractTrailerKey(details.videos)
  }
}

// Used for "More Like This" — cross-referenced against the user's own
// library by tmdbId (no point suggesting something they don't own).
export async function fetchRecommendedTmdbIds(
  mediaType: 'movie' | 'tv',
  tmdbId: number
): Promise<number[]> {
  const results = await tmdbGet<{ results: Array<{ id: number }> }>(
    `/${mediaType}/${tmdbId}/recommendations`
  )
  return (results?.results ?? []).map((r) => r.id)
}

export async function matchSeasonEpisodes(
  tmdbShowId: number,
  seasonNumber: number
): Promise<EpisodeMatch[]> {
  const season = await tmdbGet<{
    episodes: Array<{
      episode_number: number
      name: string
      overview: string
      still_path: string | null
      air_date: string | null
    }>
  }>(`/tv/${tmdbShowId}/season/${seasonNumber}`)
  if (!season?.episodes) return []

  const matches: EpisodeMatch[] = []
  for (const ep of season.episodes) {
    const stillPath = ep.still_path ? await cacheImage(ep.still_path, 'w300') : null
    matches.push({
      seasonNumber,
      episodeNumber: ep.episode_number,
      title: ep.name,
      overview: ep.overview || null,
      stillPath,
      airDate: ep.air_date
    })
  }
  return matches
}
