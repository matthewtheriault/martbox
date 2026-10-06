import type { Express, Request, Response } from 'express'
import express from 'express'
import { db } from './db'
import { albumsByIds, tracksByIds } from './music'
import type { MusicListening, MusicPlaylist, MusicPlaylistDetail, PlaylistImportResult } from '../shared/types'
import { type ImportRow, type LibraryTrack, makeMatcher, readPlaylistCsv } from './playlistImportCore'

// Each person's own music: playlists, and what they've listened to (for
// Recently Played and their most played songs). Kept per profile, like the
// watchlist; a signed-in device only ever sees its own person's.

db.exec(`
  CREATE TABLE IF NOT EXISTS music_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS music_playlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES music_playlists(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS music_plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
    played_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_music_playlists_profile ON music_playlists(profile_id);
  CREATE INDEX IF NOT EXISTS idx_music_playlist_items ON music_playlist_items(playlist_id, position);
  CREATE INDEX IF NOT EXISTS idx_music_plays_profile ON music_plays(profile_id, played_at);
`)

const MAX_NAME = 100
const MAX_ITEMS = 5000

interface PlaylistRow {
  id: number
  name: string
  updated_at: string
}

function itemsOf(playlistId: number): { id: number; trackId: number }[] {
  return db
    .prepare('SELECT id, track_id AS trackId FROM music_playlist_items WHERE playlist_id = ? ORDER BY position, id')
    .all(playlistId) as { id: number; trackId: number }[]
}

function summary(row: PlaylistRow, trackIds: number[]): MusicPlaylist {
  const tracks = tracksByIds(trackIds)
  const present = trackIds.map((id) => tracks.get(id)).filter((t) => t !== undefined)
  const covers: number[] = []
  for (const t of present) {
    if (t.hasCover && !covers.includes(t.albumId)) covers.push(t.albumId)
    if (covers.length === 4) break
  }
  return {
    id: row.id,
    name: row.name,
    trackCount: present.length,
    durationSeconds: present.reduce((sum, t) => sum + t.durationSeconds, 0),
    coverAlbumIds: covers,
    updatedAt: row.updated_at
  }
}

function ownPlaylist(profileId: number, id: number): PlaylistRow | undefined {
  return db
    .prepare('SELECT id, name, updated_at FROM music_playlists WHERE id = ? AND profile_id = ?')
    .get(id, profileId) as PlaylistRow | undefined
}

function touch(id: number): void {
  db.prepare("UPDATE music_playlists SET updated_at = datetime('now') WHERE id = ?").run(id)
}

export function listPlaylists(profileId: number): MusicPlaylist[] {
  const rows = db
    .prepare('SELECT id, name, updated_at FROM music_playlists WHERE profile_id = ? ORDER BY updated_at DESC, id DESC')
    .all(profileId) as PlaylistRow[]
  return rows.map((r) => summary(r, itemsOf(r.id).map((i) => i.trackId)))
}

export function getPlaylist(profileId: number, id: number): MusicPlaylistDetail | null {
  const row = ownPlaylist(profileId, id)
  if (!row) return null
  const items = itemsOf(id)
  const tracks = tracksByIds(items.map((i) => i.trackId))
  const kept = items.filter((i) => tracks.has(i.trackId))
  return {
    ...summary(row, kept.map((i) => i.trackId)),
    tracks: kept.map((i) => tracks.get(i.trackId)!),
    itemIds: kept.map((i) => i.id)
  }
}

export function createPlaylist(profileId: number, name: string, trackIds: number[]): MusicPlaylistDetail {
  const id = Number(db.prepare('INSERT INTO music_playlists (profile_id, name) VALUES (?, ?)').run(profileId, name).lastInsertRowid)
  if (trackIds.length) addToPlaylist(profileId, id, trackIds)
  return getPlaylist(profileId, id)!
}

export function addToPlaylist(profileId: number, id: number, trackIds: number[]): boolean {
  if (!ownPlaylist(profileId, id)) return false
  const known = tracksByIds(trackIds)
  const count = (db.prepare('SELECT COUNT(*) AS n FROM music_playlist_items WHERE playlist_id = ?').get(id) as { n: number }).n
  const next = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM music_playlist_items WHERE playlist_id = ?').get(id) as { p: number }).p
  const insert = db.prepare('INSERT INTO music_playlist_items (playlist_id, track_id, position) VALUES (?, ?, ?)')
  const add = db.transaction((ids: number[]) => {
    ids.filter((t) => known.has(t)).slice(0, Math.max(0, MAX_ITEMS - count)).forEach((t, i) => insert.run(id, t, next + i))
  })
  add(trackIds)
  touch(id)
  return true
}

export function removeFromPlaylist(profileId: number, id: number, itemId: number): boolean {
  if (!ownPlaylist(profileId, id)) return false
  db.prepare('DELETE FROM music_playlist_items WHERE id = ? AND playlist_id = ?').run(itemId, id)
  touch(id)
  return true
}

// Moves one item to [toIndex] in the playlist's order.
export function movePlaylistItem(profileId: number, id: number, itemId: number, toIndex: number): boolean {
  if (!ownPlaylist(profileId, id)) return false
  const ids = itemsOf(id).map((i) => i.id)
  const from = ids.indexOf(itemId)
  if (from < 0) return false
  ids.splice(from, 1)
  ids.splice(Math.max(0, Math.min(ids.length, toIndex)), 0, itemId)
  const set = db.prepare('UPDATE music_playlist_items SET position = ? WHERE id = ?')
  db.transaction(() => ids.forEach((item, position) => set.run(position, item)))()
  touch(id)
  return true
}

export function renamePlaylist(profileId: number, id: number, name: string): boolean {
  const result = db.prepare('UPDATE music_playlists SET name = ?, updated_at = datetime(\'now\') WHERE id = ? AND profile_id = ?').run(name, id, profileId)
  return result.changes > 0
}

export function deletePlaylist(profileId: number, id: number): boolean {
  return db.prepare('DELETE FROM music_playlists WHERE id = ? AND profile_id = ?').run(id, profileId).changes > 0
}

// Makes playlists from an exported playlist file: one per playlist in it,
// with the songs found on this server, in order. Songs not found are listed.
export function importPlaylists(profileId: number, name: string, csv: string): PlaylistImportResult {
  const rows = readPlaylistCsv(csv)
  if (rows.length === 0) throw new Error('That file has no songs in it')
  const library = db
    .prepare(
      `SELECT t.id, t.title, t.artist, ar.name AS albumArtist, al.title AS album, t.duration AS durationSeconds
       FROM music_tracks t JOIN music_albums al ON al.id = t.album_id JOIN music_artists ar ON ar.id = al.artist_id`
    )
    .all() as LibraryTrack[]
  const matcher = makeMatcher(library)
  const groups = new Map<string, ImportRow[]>()
  for (const row of rows) {
    const key = (row.playlist ?? name).trim().slice(0, MAX_NAME) || name
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  const result: PlaylistImportResult = { playlists: [], missing: [] }
  for (const [playlistName, group] of groups) {
    const ids: number[] = []
    for (const row of group.slice(0, MAX_ITEMS)) {
      const id = matcher.match(row)
      if (id !== null) ids.push(id)
      else result.missing.push({ playlist: playlistName, title: row.title, artist: row.artist })
    }
    if (ids.length === 0) continue
    const made = createPlaylist(profileId, playlistName, ids)
    result.playlists.push({ id: made.id, name: playlistName, matched: ids.length, total: Math.min(group.length, MAX_ITEMS) })
  }
  return result
}

// A song counts as played once a client has played half of it (or four
// minutes); playing the same one again within a minute counts once.
export function recordPlay(profileId: number, trackId: number): boolean {
  if (tracksByIds([trackId]).size === 0) return false
  const recent = db
    .prepare("SELECT 1 FROM music_plays WHERE profile_id = ? AND track_id = ? AND played_at > datetime('now', '-60 seconds')")
    .get(profileId, trackId)
  if (!recent) db.prepare('INSERT INTO music_plays (profile_id, track_id) VALUES (?, ?)').run(profileId, trackId)
  return true
}

export function listening(profileId: number): MusicListening {
  const recent = db
    .prepare(
      `SELECT p.track_id AS trackId, t.album_id AS albumId FROM music_plays p
       JOIN music_tracks t ON t.id = p.track_id WHERE p.profile_id = ? ORDER BY p.played_at DESC, p.id DESC LIMIT 500`
    )
    .all(profileId) as { trackId: number; albumId: number }[]
  const recentTrackIds = [...new Set(recent.map((r) => r.trackId))].slice(0, 20)
  const recentAlbumIds = [...new Set(recent.map((r) => r.albumId))].slice(0, 12)
  const top = db
    .prepare(
      `SELECT track_id AS trackId, COUNT(*) AS plays FROM music_plays
       WHERE profile_id = ? AND played_at > datetime('now', '-90 days')
       GROUP BY track_id ORDER BY plays DESC, MAX(played_at) DESC LIMIT 20`
    )
    .all(profileId) as { trackId: number }[]
  const tracks = tracksByIds([...recentTrackIds, ...top.map((t) => t.trackId)])
  const albums = albumsByIds(recentAlbumIds)
  return {
    recentAlbums: recentAlbumIds.map((id) => albums.get(id)).filter((a) => a !== undefined),
    recentTracks: recentTrackIds.map((id) => tracks.get(id)).filter((t) => t !== undefined),
    topTracks: top.map((t) => tracks.get(t.trackId)).filter((t) => t !== undefined)
  }
}

// --- HTTP

type CanAct = (res: Response, profileId: number, pin: string | undefined) => boolean

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim().slice(0, MAX_NAME)
  return name || null
}

function trackIdList(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_ITEMS) : []
}

export function registerMusicPersonalRoutes(app: Express, canActAsProfile: CanAct): void {
  const json = express.json({ limit: '256kb' })

  // The profile a request acts for, or null after answering 403.
  const profileOf = (req: Request, res: Response): number | null => {
    const source = req.method === 'GET' ? req.query : (req.body ?? {})
    const profileId = parseInt(String(source.profileId), 10)
    const pin = typeof source.pin === 'string' ? source.pin : undefined
    if (!Number.isInteger(profileId) || !canActAsProfile(res, profileId, pin)) {
      res.status(403).json({ error: 'Wrong or missing PIN for this profile' })
      return null
    }
    return profileId
  }
  const playlistId = (req: Request): number => parseInt(req.params.id, 10)
  const done = (res: Response, ok: boolean): void => {
    if (ok) res.json({ ok: true })
    else res.status(404).json({ error: 'No such playlist' })
  }

  app.get('/api/music/playlists', (req, res) => {
    const profileId = profileOf(req, res)
    if (profileId !== null) res.json(listPlaylists(profileId))
  })
  app.post('/api/music/playlists', json, (req, res) => {
    const profileId = profileOf(req, res)
    if (profileId === null) return
    const name = cleanName(req.body.name)
    if (!name) {
      res.status(400).json({ error: 'A playlist needs a name' })
      return
    }
    res.json(createPlaylist(profileId, name, trackIdList(req.body.trackIds)))
  })
  // A whole exported file, so a bigger limit than the other routes.
  app.post('/api/music/playlists/import', express.json({ limit: '8mb' }), (req, res) => {
    const profileId = profileOf(req, res)
    if (profileId === null) return
    if (typeof req.body.csv !== 'string') {
      res.status(400).json({ error: 'No playlist file' })
      return
    }
    try {
      res.json(importPlaylists(profileId, cleanName(req.body.name) ?? 'Imported playlist', req.body.csv))
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Couldn’t read that file' })
    }
  })
  app.get('/api/music/playlists/:id', (req, res) => {
    const profileId = profileOf(req, res)
    if (profileId === null) return
    const playlist = getPlaylist(profileId, playlistId(req))
    if (playlist) res.json(playlist)
    else res.status(404).json({ error: 'No such playlist' })
  })
  app.post('/api/music/playlists/:id/add', json, (req, res) => {
    const profileId = profileOf(req, res)
    if (profileId !== null) done(res, addToPlaylist(profileId, playlistId(req), trackIdList(req.body.trackIds)))
  })
  app.post('/api/music/playlists/:id/remove', json, (req, res) => {
    const profileId = profileOf(req, res)
    if (profileId !== null) done(res, removeFromPlaylist(profileId, playlistId(req), Number(req.body.itemId)))
  })
  app.post('/api/music/playlists/:id/move', json, (req, res) => {
    const profileId = profileOf(req, res)
    if (profileId !== null) done(res, movePlaylistItem(profileId, playlistId(req), Number(req.body.itemId), Number(req.body.toIndex)))
  })
  app.post('/api/music/playlists/:id/rename', json, (req, res) => {
    const profileId = profileOf(req, res)
    if (profileId === null) return
    const name = cleanName(req.body.name)
    if (!name) {
      res.status(400).json({ error: 'A playlist needs a name' })
      return
    }
    done(res, renamePlaylist(profileId, playlistId(req), name))
  })
  app.post('/api/music/playlists/:id/delete', json, (req, res) => {
    const profileId = profileOf(req, res)
    if (profileId !== null) done(res, deletePlaylist(profileId, playlistId(req)))
  })

  app.post('/api/music/plays', json, (req, res) => {
    const profileId = profileOf(req, res)
    if (profileId === null) return
    if (recordPlay(profileId, Number(req.body.trackId))) res.json({ ok: true })
    else res.status(404).json({ error: 'No such track' })
  })
  app.get('/api/music/listening', (req, res) => {
    const profileId = profileOf(req, res)
    if (profileId !== null) res.json(listening(profileId))
  })
}
