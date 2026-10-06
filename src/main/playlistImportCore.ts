// Playlist import: a CSV exported from Spotify (Exportify), TuneMyMusic,
// Soundiiz and the like, matched against the songs on the server. Pure, so
// it's tested without a library (playlistImportCore.test.ts).

export interface ImportRow {
  title: string
  artist: string
  album: string
  durationMs: number | null
  // Set when one file holds several playlists (TuneMyMusic does this).
  playlist: string | null
}

export interface LibraryTrack {
  id: number
  title: string
  artist: string
  albumArtist: string
  album: string
  durationSeconds: number
}

// --- Reading the file

// RFC 4180: quoted fields can hold commas, quotes ("") and line breaks.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

const COLUMNS = {
  title: ['track name', 'title', 'song', 'song name', 'track', 'name'],
  artist: ['artist name(s)', 'artist name', 'artist names', 'artist', 'artists'],
  album: ['album name', 'album', 'album title'],
  duration: ['duration (ms)', 'duration_ms', 'duration ms'],
  playlist: ['playlist name', 'playlist']
}

export function readPlaylistCsv(text: string): ImportRow[] {
  const [header, ...rows] = parseCsv(text)
  if (!header) return []
  const names = header.map((h) => h.trim().toLowerCase())
  const col = (options: string[]): number => {
    for (const o of options) {
      const i = names.indexOf(o)
      if (i >= 0) return i
    }
    return -1
  }
  const title = col(COLUMNS.title)
  if (title < 0) throw new Error("Couldn't find the song titles in that file. Is it a playlist exported as CSV?")
  const artist = col(COLUMNS.artist)
  const album = col(COLUMNS.album)
  const duration = col(COLUMNS.duration)
  const playlist = col(COLUMNS.playlist)
  const at = (r: string[], i: number): string => (i >= 0 ? (r[i] ?? '').trim() : '')
  return rows
    .map((r) => {
      const ms = Number(at(r, duration))
      return {
        title: at(r, title),
        artist: at(r, artist),
        album: at(r, album),
        durationMs: duration >= 0 && Number.isFinite(ms) && ms > 0 ? ms : null,
        playlist: at(r, playlist) || null
      }
    })
    .filter((r) => r.title !== '')
}

// --- Matching

// Words in brackets or after " - " that don't change which recording it is.
const EXTRA = /\b(feat|ft|featuring|with|remaster|remastered|remasterd|deluxe|bonus|version|mono|stereo|single|radio edit|explicit|clean|edit|expanded|anniversary)\b/

function plain(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
}

function words(s: string): string {
  return s.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
}

// "Song (feat. X) - Remastered 2011" → "song"; "Song (Live)" stays apart
// from "Song".
export function baseTitle(s: string): string {
  let t = plain(s)
  t = t.replace(/[([][^)\]]*[)\]]/g, (m) => (EXTRA.test(m) ? ' ' : m))
  t = t.replace(/\s[-–—]\s.*$/, (m) => (EXTRA.test(m) ? '' : m))
  t = t.replace(/\s(feat|ft|featuring)\b.*$/, '')
  return words(t)
}

// Every name in an artist field: "A, B & C feat. D" → a, b, c, d. "The"
// is dropped ("Beatles" and "The Beatles" are the same band).
export function artistNames(s: string): string[] {
  return plain(s)
    .split(/,|;|\/|&|\band\b|\bx\b|\bwith\b|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b/)
    .map((n) => words(n).replace(/^the /, ''))
    .filter((n) => n !== '')
}

interface Indexed extends LibraryTrack {
  titleKey: string
  artists: Set<string>
  albumKey: string
}

export interface Matcher {
  match(row: ImportRow): number | null
}

export function makeMatcher(library: LibraryTrack[]): Matcher {
  const byTitle = new Map<string, Indexed[]>()
  const all: Indexed[] = []
  for (const t of library) {
    const key = baseTitle(t.title)
    const indexed: Indexed = {
      ...t,
      titleKey: key,
      artists: new Set([...artistNames(t.artist), ...artistNames(t.albumArtist)]),
      albumKey: baseTitle(t.album)
    }
    all.push(indexed)
    const same = byTitle.get(key)
    if (same) same.push(indexed)
    else byTitle.set(key, [indexed])
  }

  const score = (row: ImportRow, t: Indexed): { artist: boolean; album: boolean; length: boolean } => ({
    artist: artistNames(row.artist).some((a) => t.artists.has(a)),
    album: row.album !== '' && baseTitle(row.album) === t.albumKey,
    length: row.durationMs !== null && Math.abs(row.durationMs / 1000 - t.durationSeconds) <= 3
  })
  const best = (row: ImportRow, candidates: Indexed[], ok: (s: ReturnType<typeof score>) => boolean): number | null => {
    let found: { id: number; points: number } | null = null
    for (const t of candidates) {
      const s = score(row, t)
      if (!ok(s)) continue
      const points = (s.artist ? 4 : 0) + (s.album ? 2 : 0) + (s.length ? 1 : 0)
      if (!found || points > found.points || (points === found.points && t.id < found.id)) found = { id: t.id, points }
    }
    return found?.id ?? null
  }

  return {
    match(row) {
      const key = baseTitle(row.title)
      if (!key) return null
      // Same title: the right artist, or the right album and length.
      const exact = best(row, byTitle.get(key) ?? [], (s) => s.artist || (s.album && s.length))
      if (exact !== null) return exact
      // A title with a little more or less on it ("Song" / "Song Pt. 1"):
      // only with the right artist and the album or length to back it up.
      const near = all.filter((t) => t.titleKey.startsWith(`${key} `) || key.startsWith(`${t.titleKey} `))
      return best(row, near, (s) => s.artist && (s.album || s.length))
    }
  }
}
