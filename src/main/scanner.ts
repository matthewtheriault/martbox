import { existsSync, readdirSync, statSync } from 'fs'
import { join, basename, extname } from 'path'
import type { Library, Movie, Show } from '../shared/types'
import {
  registerMovieFile,
  upsertShow,
  registerEpisodeFile,
  foldShowFolderPath,
  findShowByTitle,
  findShowByFolderPathAny,
  pruneMissingMovies,
  pruneMissingEpisodes
} from './repository'

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

// Non-recursive: only files sitting directly in `dir`, not inside any of its
// subdirectories (those are already covered separately by walk() over each
// show folder — recursing here too would double-count them).
function listTopLevelVideoFiles(dir: string): string[] {
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && isVideoFile(e.name))
    .map((e) => join(dir, e.name))
}

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/gi, ' ')
}

// Trims separator junk left dangling at either edge after slicing a title at
// a cut point (e.g. "Ted - " -> "Ted"). Leading also strips stray open
// brackets, but trailing deliberately leaves brackets alone — a legitimate
// closing ")" (as in "...(Colour Corrected)") must survive; dangling
// *unmatched* openers at the end are handled separately, by removing the
// whole incomplete group instead of just the bracket character.
function trimEdgeJunk(s: string): string {
  return s.replace(/^[-\s[({]+/, '').replace(/[-\s]+$/, '')
}

// A QUALITY_TAGS cut can land inside a bracket group, leaving its opener
// dangling with no matching closer (e.g. "...(Colour Corrected) [DVD] ["
// after everything from "Dual Audio" on gets stripped). Drop the whole
// unclosed trailing group rather than just the bracket character itself.
function stripIncompleteTrailingBracket(s: string): string {
  const openIdx = Math.max(s.lastIndexOf('['), s.lastIndexOf('('))
  if (openIdx === -1) return s
  const after = s.slice(openIdx)
  return after.includes(']') || after.includes(')') ? s : s.slice(0, openIdx)
}

function cleanTitle(raw: string): string {
  const normalized = decodeHtmlEntities(raw)
    .replace(/[._]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return stripIncompleteTrailingBracket(trimEdgeJunk(normalized)).trim()
}

// Torrent/tracker watermarks and fansub-group tags prepended to release
// names (e.g. "www.UIndex.org    -    Show.S01E01...", "[Anime Time] Show...").
// Stripped before any other parsing so they never end up as part of the title.
const WWW_WATERMARK = /^www\.[\w-]+\.[a-z]{2,6}\s*-+\s*/i
const LEADING_BRACKET_TAG = /^(?:\[[^\]]*\]\s*)+/

function stripLeadingNoise(raw: string): string {
  return raw.replace(WWW_WATERMARK, '').replace(LEADING_BRACKET_TAG, '')
}

const QUALITY_TAGS =
  /\b(1080p|2160p|720p|480p|4k|uhd|hdr|bluray|blu-ray|web[-.]?dl|webrip|hdtv|dvdrip|x264|x265|h264|h265|hevc|aac|ac3|dts|remux|proper|repack|extended|directors?[.\s]?cut|multi|dual)\b.*$/i

// A 4-digit year and a resolution written as "<width> x <height>" (e.g.
// "1920 x 960", "1920x1080") look identical to a plain digit regex — both
// are just (19|20)\d{2}. Every year-detection regex below excludes the
// resolution case with a "(?!\s*[x×]\s*\d)" guard so it never gets misread
// as a year (real-world example: a release literally named
// "...Complete 1920 x 960 x264...").

export interface ParsedMovie {
  title: string
  year: number | null
}

export function parseMovieName(nameWithoutExt: string): ParsedMovie {
  const name = stripLeadingNoise(nameWithoutExt)
  const yearMatch = name.match(/^(.*?)[\s.([_-]*((19|20)\d{2})(?!\s*[x×]\s*\d)\b/)
  if (yearMatch) {
    const title = cleanTitle(cleanTitle(yearMatch[1]).replace(QUALITY_TAGS, ''))
    return { title: title || cleanTitle(name), year: parseInt(yearMatch[2], 10) }
  }
  const title = cleanTitle(cleanTitle(name).replace(QUALITY_TAGS, ''))
  return { title: title || cleanTitle(name), year: null }
}

export interface ParsedEpisode {
  showTitle: string
  season: number
  episode: number
  episodeTitle: string | null
}

// Allows a separator between the season and episode markers (e.g.
// "S02 E01", "S01 - E01"), not just the tight "S02E01" form.
const SXXEYY = /^(.*?)[\s._-]*[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})(?:[Ee]\d{1,3})?[\s._-]*(.*)$/
const NXNN = /^(.*?)[\s._-]*(\d{1,2})x(\d{1,3})[\s._-]*(.*)$/
// Fully spelled out, e.g. "Keeping Up Appearances Season 01 Episode 01 - ...".
const SEASON_EPISODE_WORDS =
  /^(.*?)\bSeason[\s._-]*(\d{1,2})\b.*?\bEpisode[\s._-]*(\d{1,3})\b[\s._-]*(.*)$/i
// Last-resort fallback for releases with no S/E marker at all, just an
// absolute episode number delimited on both sides (e.g. "01_Asteroid_Blues...",
// "Dragon Ball Z - 001 - The New Threat"). Requires 2+ digits and a real
// delimiter on both sides so it doesn't grab quality tags like "x264"/"720p"
// (no delimiter between the letter and the digits there) — season defaults to 1.
const BARE_NUMBER = /(?:^|[\s._-])(\d{2,4})(?:[\s._-]|$)/

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
]

interface DatedMatch {
  year: number
  month: number
  day: number
  index: number
  length: number
}

// Daily/weekly shows with no season structure at all (news, talk shows,
// wrestling) are frequently named by air date instead — and inconsistently
// so, even within one show's own folder. Tries several real-world date
// layouts in turn; validates month/day ranges so it doesn't misfire on
// unrelated number sequences.
function parseDatedEpisode(name: string): DatedMatch | null {
  let m = name.match(/\b((?:19|20)\d{2})[\s._-](\d{1,2})[\s._-](\d{1,2})\b/)
  if (m && m.index !== undefined) {
    const year = parseInt(m[1], 10)
    const month = parseInt(m[2], 10)
    const day = parseInt(m[3], 10)
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day, index: m.index, length: m[0].length }
    }
  }

  m = name.match(/\b(\d{1,2})-(\d{1,2})-(\d{2})\b/)
  if (m && m.index !== undefined) {
    const day = parseInt(m[1], 10)
    const month = parseInt(m[2], 10)
    const year = 2000 + parseInt(m[3], 10)
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day, index: m.index, length: m[0].length }
    }
  }

  m = name.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)[\s._-]+(\d{1,2})(?:st|nd|rd|th)?[\s._-]+((?:19|20)\d{2})\b/i
  )
  if (m && m.index !== undefined) {
    const month = MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1
    const day = parseInt(m[2], 10)
    const year = parseInt(m[3], 10)
    if (day >= 1 && day <= 31) {
      return { year, month, day, index: m.index, length: m[0].length }
    }
  }

  m = name.match(/\b(\d{1,2})[\s._-](\d{1,2})[\s._-]((?:19|20)\d{2})\b/)
  if (m && m.index !== undefined) {
    const month = parseInt(m[1], 10)
    const day = parseInt(m[2], 10)
    const year = parseInt(m[3], 10)
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day, index: m.index, length: m[0].length }
    }
  }

  // Month + year only, no day (rare, incomplete releases) — default day 1.
  m = name.match(/\b(\d{1,2})[\s._-]((?:19|20)\d{2})\b/)
  if (m && m.index !== undefined) {
    const month = parseInt(m[1], 10)
    const year = parseInt(m[2], 10)
    if (month >= 1 && month <= 12) {
      return { year, month, day: 1, index: m.index, length: m[0].length }
    }
  }

  return null
}

export function parseEpisodeName(nameWithoutExt: string): ParsedEpisode | null {
  const name = stripLeadingNoise(nameWithoutExt)
  let m = name.match(SXXEYY)
  if (!m) m = name.match(NXNN)
  if (!m) m = name.match(SEASON_EPISODE_WORDS)
  if (m) {
    const showTitle = cleanTitle(cleanTitle(m[1]).replace(QUALITY_TAGS, ''))
    const season = parseInt(m[2], 10)
    const episode = parseInt(m[3], 10)
    const rest = cleanTitle(cleanTitle(m[4] || '').replace(QUALITY_TAGS, ''))
    return { showTitle, season, episode, episodeTitle: rest || null }
  }

  const dated = parseDatedEpisode(name)
  if (dated) {
    const showTitle = cleanTitle(cleanTitle(name.slice(0, dated.index)).replace(QUALITY_TAGS, ''))
    const rest = cleanTitle(
      cleanTitle(name.slice(dated.index + dated.length)).replace(QUALITY_TAGS, '')
    )
    // Season = air year, episode = MMDD, so episodes still sort chronologically
    // within a season without needing a second pass over sibling files.
    return {
      showTitle,
      season: dated.year,
      episode: dated.month * 100 + dated.day,
      episodeTitle: rest || null
    }
  }

  const bare = name.match(BARE_NUMBER)
  if (!bare || bare.index === undefined) return null
  const showTitle = cleanTitle(cleanTitle(name.slice(0, bare.index)).replace(QUALITY_TAGS, ''))
  const episode = parseInt(bare[1], 10)
  const rest = cleanTitle(
    cleanTitle(name.slice(bare.index + bare[0].length)).replace(QUALITY_TAGS, '')
  )
  return { showTitle, season: 1, episode, episodeTitle: rest || null }
}

export function scanMovieLibrary(library: Library): Movie[] {
  const files = walk(library.path)
  const movies: Movie[] = []
  for (const file of files) {
    const name = basename(file, extname(file))
    const parentDir = basename(join(file, '..'))
    const parsed =
      parentDir !== basename(library.path) && /(19|20)\d{2}(?!\s*[x×]\s*\d)/.test(parentDir)
        ? parseMovieName(parentDir)
        : parseMovieName(name)
    const movie = registerMovieFile({
      libraryId: library.id,
      filePath: file,
      title: parsed.title,
      sortTitle: parsed.title.replace(/^(the|a|an)\s+/i, '').toLowerCase(),
      year: parsed.year
    })
    movies.push(movie)
  }

  // Only prune when the library root is actually reachable — if a drive is
  // disconnected, walk() silently returns [] and pruning here would look
  // identical to "the user deleted everything," wiping the whole library.
  if (existsSync(library.path)) {
    pruneMissingMovies(library.id, new Set(files))
  }

  return movies
}

// Some releases lay out one folder per season directly under the library
// root (e.g. "30.Rock.S01.1080p...", "30.Rock.S02...") instead of nesting
// season folders under a show folder. Detect a season marker so those get
// grouped back into a single show instead of becoming separate shows.
const SEASON_MARKER = /\bSeason[\s._-]*(\d{1,2})\b|\b[Ss](\d{1,2})\b(?![Ee]\d)/i
// Other releases go one step further and lay out one folder per *episode*
// directly under the library root (e.g. "Drake.and.Josh.S01E02.Dune.Buggy...").
// SEASON_MARKER deliberately ignores "S01" here since it's followed by an
// episode marker, so without this the SxxExx code (and everything after,
// which differs per episode) would stay in the title and each episode
// folder would become its own show instead of merging.
const EPISODE_MARKER = /\b[Ss](\d{1,2})[Ee]\d{1,3}\b/

export function parseShowFolderName(folderName: string): {
  title: string
  year: number | null
  season: number | null
} {
  const cleaned = cleanTitle(stripLeadingNoise(folderName))
  const yearMatch = cleaned.match(/(19|20)\d{2}(?!\s*[x×]\s*\d)/)
  const seasonMatch = cleaned.match(SEASON_MARKER)
  const episodeMatch = cleaned.match(EPISODE_MARKER)

  const year = yearMatch ? parseInt(yearMatch[0], 10) : null
  const season = seasonMatch
    ? parseInt(seasonMatch[1] ?? seasonMatch[2], 10)
    : episodeMatch
      ? parseInt(episodeMatch[1], 10)
      : null

  const cutPoints = [yearMatch?.index, seasonMatch?.index, episodeMatch?.index].filter(
    (i): i is number => i !== undefined
  )
  const cutAt = cutPoints.length > 0 ? Math.min(...cutPoints) : cleaned.length
  const title = cleanTitle(cleaned.slice(0, cutAt).replace(QUALITY_TAGS, ''))

  return { title: title || cleaned, year, season }
}

interface ShowGroup {
  title: string
  year: number | null
  representativeDir: string
  dirs: string[]
  looseFiles: string[]
}

export function scanTvLibrary(library: Library): Show[] {
  const shows: Show[] = []
  const showDirs = listSubdirectories(library.path)
  const dirsToProcess = showDirs.length > 0 ? showDirs : [library.path]

  const groups = new Map<string, ShowGroup>()
  for (const dir of dirsToProcess) {
    const folderName = basename(dir)
    let title: string
    let year: number | null

    if (showDirs.length > 0) {
      const parsed = parseShowFolderName(folderName)
      title = parsed.title
      year = parsed.year
    } else {
      const files = walk(dir)
      title =
        (files[0] && parseEpisodeName(basename(files[0], extname(files[0])))?.showTitle) ||
        cleanTitle(folderName)
      year = null
    }

    // Group by title alone, not title+year: release folders for the same
    // show are frequently inconsistent about whether the year is present
    // (e.g. "Abbott Elementary (2021) S04..." next to "Abbott.Elementary.S03..."
    // with no year at all), so requiring an exact year match would leave
    // those un-merged.
    const key = title.toLowerCase()
    const group = groups.get(key)
    if (group) {
      group.dirs.push(dir)
      if (group.year === null && year !== null) group.year = year
    } else {
      groups.set(key, { title, year, representativeDir: dir, dirs: [dir], looseFiles: [] })
    }
  }

  // Some releases are dropped straight into the library root as a loose file
  // instead of a per-show folder (e.g. "TV Shows\Ted.Lasso.S04E03...mkv"
  // sitting next to "TV Shows\Ted Lasso\"). Only relevant when there are
  // other show folders present — with none at all, dirsToProcess above
  // already falls back to walking the whole library root as one flat show.
  if (showDirs.length > 0) {
    for (const file of listTopLevelVideoFiles(library.path)) {
      const name = basename(file, extname(file))
      const parsed = parseEpisodeName(name)
      if (!parsed || !parsed.showTitle) continue

      const key = parsed.showTitle.toLowerCase()
      const group = groups.get(key)
      if (group) {
        group.looseFiles.push(file)
      } else {
        groups.set(key, {
          title: parsed.showTitle,
          year: null,
          representativeDir: join(library.path, parsed.showTitle),
          dirs: [],
          looseFiles: [file]
        })
      }
    }
  }

  const allFoundFiles = new Set<string>()

  for (const group of groups.values()) {
    const files = [...group.dirs.flatMap(walk), ...group.looseFiles]
    for (const file of files) allFoundFiles.add(file)
    if (files.length === 0) continue

    // Look up by folder_path first — it's stable across rescans, unlike a
    // freshly re-parsed title, which drifts away from the DB row's title the
    // moment this show gets TMDb-matched or manually renamed. Falling back
    // straight to a title-keyed upsertShow() there used to hit its
    // ON CONFLICT(folder_path) on every later rescan and reset tmdb_id/
    // overview/poster/etc. back to null, silently undoing the match (or a
    // manual edit) every time.
    //
    // Always include representativeDir even when it's not already one of
    // group.dirs — true for a loose-file-only group, whose dirs is empty.
    // Without it, this lookup is skipped entirely (findShowByFolderPathAny
    // short-circuits on an empty array) and every rescan falls through to
    // upsertShow's ON CONFLICT(folder_path), which — despite matching the
    // exact same synthetic path as last time — re-triggers the very reset
    // this lookup exists to prevent, and quietly reassigns the file's
    // episode row onto that reset show every time.
    //
    // Only once that fails do we fold into a same-titled show from another
    // library (seasons spread across drives), then finally create new.
    const lookupDirs = group.dirs.includes(group.representativeDir)
      ? group.dirs
      : [group.representativeDir, ...group.dirs]
    const show =
      findShowByFolderPathAny(lookupDirs) ??
      findShowByTitle(group.title) ??
      upsertShow({
        libraryId: library.id,
        folderPath: group.representativeDir,
        title: group.title,
        sortTitle: group.title.replace(/^(the|a|an)\s+/i, '').toLowerCase(),
        year: group.year,
        tmdbId: null,
        overview: null,
        posterPath: null,
        backdropPath: null,
        rating: null,
        genres: [],
        cast: [],
        crew: [],
        trailerKey: null,
        titleLocked: false
      })
    shows.push(show)

    for (const file of files) {
      const name = basename(file, extname(file))
      const parsed = parseEpisodeName(name)
      if (!parsed) continue
      registerEpisodeFile({
        showId: show.id,
        seasonNumber: parsed.season,
        episodeNumber: parsed.episode,
        filePath: file,
        fallbackTitle: parsed.episodeTitle || `Episode ${parsed.episode}`
      })
    }

    // A rescan can merge folders that used to each be their own show (e.g.
    // one folder per season, possibly in another library on another drive)
    // — episodes above were just reassigned to the merged show via
    // upsertEpisode's ON CONFLICT(file_path), so any other folder's leftover
    // show row (which may not be group.representativeDir, when `show` came
    // from findShowByTitle instead of this group) is now empty and safe to
    // fold away. Folding (not deleting) keeps this stable on the *next*
    // rescan too — see foldShowFolderPath.
    for (const dir of group.dirs) {
      if (dir !== show.folderPath) foldShowFolderPath(dir, show.id)
    }
  }

  // Only prune when the library root is actually reachable — if a drive is
  // disconnected, the walks above silently return [] and pruning here would
  // look identical to "the user deleted everything," wiping the whole show.
  if (existsSync(library.path)) {
    pruneMissingEpisodes(library.path, allFoundFiles)
  }

  return shows
}

export function scanLibrary(library: Library): { movies: Movie[]; shows: Show[] } {
  if (library.type === 'movie') {
    return { movies: scanMovieLibrary(library), shows: [] }
  }
  return { movies: [], shows: scanTvLibrary(library) }
}
