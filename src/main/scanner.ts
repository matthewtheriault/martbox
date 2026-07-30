import { readdirSync, statSync } from 'fs'
import { join, basename, extname } from 'path'
import type { Library, Movie, Show } from '../shared/types'
import { upsertMovie, upsertShow, upsertEpisode } from './repository'

const VIDEO_EXTENSIONS = new Set([
  '.mkv',
  '.mp4',
  '.avi',
  '.mov',
  '.m4v',
  '.wmv',
  '.ts',
  '.webm',
  '.flv',
  '.mpg',
  '.mpeg'
])

export function isVideoFile(path: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(path).toLowerCase())
}

function walk(dir: string): string[] {
  let results: string[] = []
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results = results.concat(walk(full))
    } else if (entry.isFile() && isVideoFile(full)) {
      results.push(full)
    }
  }
  return results
}

function listSubdirectories(dir: string): string[] {
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => join(dir, e.name))
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/[._]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[-\s]+$/, '')
    .trim()
}

const QUALITY_TAGS =
  /\b(1080p|2160p|720p|480p|4k|uhd|hdr|bluray|blu-ray|web[-.]?dl|webrip|hdtv|dvdrip|x264|x265|h264|h265|hevc|aac|ac3|dts|remux|proper|repack|extended|directors?[.\s]?cut|multi|dual)\b.*$/i

export interface ParsedMovie {
  title: string
  year: number | null
}

export function parseMovieName(nameWithoutExt: string): ParsedMovie {
  const yearMatch = nameWithoutExt.match(/^(.*?)[\s.([_-]*((19|20)\d{2})\b/)
  if (yearMatch) {
    const title = cleanTitle(yearMatch[1]).replace(QUALITY_TAGS, '').trim()
    return { title: title || cleanTitle(nameWithoutExt), year: parseInt(yearMatch[2], 10) }
  }
  const title = cleanTitle(nameWithoutExt).replace(QUALITY_TAGS, '').trim()
  return { title: title || cleanTitle(nameWithoutExt), year: null }
}

export interface ParsedEpisode {
  showTitle: string
  season: number
  episode: number
  episodeTitle: string | null
}

const SXXEYY = /^(.*?)[\s._-]*[Ss](\d{1,2})[Ee](\d{1,3})(?:[Ee]\d{1,3})?[\s._-]*(.*)$/
const NXNN = /^(.*?)[\s._-]*(\d{1,2})x(\d{1,3})[\s._-]*(.*)$/

export function parseEpisodeName(nameWithoutExt: string): ParsedEpisode | null {
  let m = nameWithoutExt.match(SXXEYY)
  if (!m) m = nameWithoutExt.match(NXNN)
  if (!m) return null
  const showTitle = cleanTitle(m[1]).replace(QUALITY_TAGS, '').trim()
  const season = parseInt(m[2], 10)
  const episode = parseInt(m[3], 10)
  const rest = cleanTitle(m[4] || '').replace(QUALITY_TAGS, '').trim()
  return { showTitle, season, episode, episodeTitle: rest || null }
}

export function scanMovieLibrary(library: Library): Movie[] {
  const files = walk(library.path)
  const movies: Movie[] = []
  for (const file of files) {
    const name = basename(file, extname(file))
    const parentDir = basename(join(file, '..'))
    const parsed =
      parentDir !== basename(library.path) && /(19|20)\d{2}/.test(parentDir)
        ? parseMovieName(parentDir)
        : parseMovieName(name)
    const movie = upsertMovie({
      libraryId: library.id,
      filePath: file,
      title: parsed.title,
      sortTitle: parsed.title.replace(/^(the|a|an)\s+/i, '').toLowerCase(),
      year: parsed.year,
      tmdbId: null,
      overview: null,
      posterPath: null,
      backdropPath: null,
      rating: null,
      runtimeMinutes: null
    })
    movies.push(movie)
  }
  return movies
}

export function scanTvLibrary(library: Library): Show[] {
  const shows: Show[] = []
  const showDirs = listSubdirectories(library.path)
  const dirsToProcess = showDirs.length > 0 ? showDirs : [library.path]

  for (const showDir of dirsToProcess) {
    const files = walk(showDir)
    if (files.length === 0) continue

    const folderName = basename(showDir)
    const showNameGuess =
      showDirs.length > 0 ? parseMovieName(folderName).title : parseEpisodeName(basename(files[0], extname(files[0])))?.showTitle

    const showTitle = showNameGuess || cleanTitle(folderName)
    const yearMatch = folderName.match(/\((19|20)\d{2}\)/)
    const year = yearMatch ? parseInt(yearMatch[0].replace(/[()]/g, ''), 10) : null

    const show = upsertShow({
      libraryId: library.id,
      folderPath: showDir,
      title: showTitle,
      sortTitle: showTitle.replace(/^(the|a|an)\s+/i, '').toLowerCase(),
      year,
      tmdbId: null,
      overview: null,
      posterPath: null,
      backdropPath: null,
      rating: null
    })
    shows.push(show)

    for (const file of files) {
      const name = basename(file, extname(file))
      const parsed = parseEpisodeName(name)
      if (!parsed) continue
      upsertEpisode({
        showId: show.id,
        seasonNumber: parsed.season,
        episodeNumber: parsed.episode,
        filePath: file,
        title: parsed.episodeTitle || `Episode ${parsed.episode}`,
        overview: null,
        stillPath: null,
        airDate: null,
        durationSeconds: null
      })
    }
  }
  return shows
}

export function scanLibrary(library: Library): { movies: Movie[]; shows: Show[] } {
  if (library.type === 'movie') {
    return { movies: scanMovieLibrary(library), shows: [] }
  }
  return { movies: [], shows: scanTvLibrary(library) }
}
