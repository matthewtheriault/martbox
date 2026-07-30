import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, existsSync, writeFileSync } from 'fs'
import { getSetting } from './db'

const TMDB_API = 'https://api.themoviedb.org/3'
const IMAGE_BASE = 'https://image.tmdb.org/t/p'

const imageCacheDir = join(app.getPath('userData'), 'cache', 'images')
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
}

export interface ShowMatch {
  tmdbId: number
  title: string
  year: number | null
  overview: string
  posterPath: string | null
  backdropPath: string | null
  rating: number
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

export async function matchMovie(title: string, year: number | null): Promise<MovieMatch | null> {
  const results = await tmdbGet<{ results: TmdbMovieSearchResult[] }>('/search/movie', {
    query: title,
    ...(year ? { year: String(year) } : {})
  })
  const best = results?.results?.[0]
  if (!best) return null

  const details = await tmdbGet<{ runtime: number | null }>(`/movie/${best.id}`)

  const posterPath = best.poster_path ? await cacheImage(best.poster_path, 'w500') : null
  const backdropPath = best.backdrop_path ? await cacheImage(best.backdrop_path, 'w1280') : null

  return {
    tmdbId: best.id,
    title: best.title,
    year: best.release_date ? parseInt(best.release_date.slice(0, 4), 10) : null,
    overview: best.overview,
    posterPath,
    backdropPath,
    rating: best.vote_average,
    runtimeMinutes: details?.runtime ?? null
  }
}

export async function matchShow(title: string, year: number | null): Promise<ShowMatch | null> {
  const results = await tmdbGet<{ results: TmdbTvSearchResult[] }>('/search/tv', {
    query: title,
    ...(year ? { first_air_date_year: String(year) } : {})
  })
  const best = results?.results?.[0]
  if (!best) return null

  const posterPath = best.poster_path ? await cacheImage(best.poster_path, 'w500') : null
  const backdropPath = best.backdrop_path ? await cacheImage(best.backdrop_path, 'w1280') : null

  return {
    tmdbId: best.id,
    title: best.name,
    year: best.first_air_date ? parseInt(best.first_air_date.slice(0, 4), 10) : null,
    overview: best.overview,
    posterPath,
    backdropPath,
    rating: best.vote_average
  }
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
