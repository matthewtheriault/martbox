import { db } from './db'
import type { Collection, CollectionItem } from '../shared/types'

// Collections the admin puts together ("Halloween", "Pixar", "Dad's
// picks"): movies and shows in the admin's order, shown to everyone as rows
// on Home and on the Collections page.

db.exec(`
  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    on_home INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS collection_items (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'show')),
    media_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (collection_id, media_type, media_id)
  );
`)

const NAME_MAX = 80
const DESCRIPTION_MAX = 300

function itemsOf(collectionId: number): CollectionItem[] {
  // Titles removed from the library drop out here (and are cleaned up).
  const rows = db
    .prepare(
      `SELECT ci.media_type AS mediaType, ci.media_id AS id,
         COALESCE(m.title, s.title) AS title, COALESCE(m.year, s.year) AS year,
         COALESCE(m.poster_path, s.poster_path) AS posterPath,
         COALESCE(m.backdrop_path, s.backdrop_path) AS backdropPath
       FROM collection_items ci
       LEFT JOIN movies m ON ci.media_type = 'movie' AND m.id = ci.media_id
       LEFT JOIN shows s ON ci.media_type = 'show' AND s.id = ci.media_id
       WHERE ci.collection_id = ?
       ORDER BY ci.position`
    )
    .all(collectionId) as (CollectionItem & { title: string | null })[]
  return rows.filter((r) => r.title !== null) as CollectionItem[]
}

function toCollection(row: { id: number; name: string; description: string; on_home: number }): Collection {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    onHome: row.on_home === 1,
    items: itemsOf(row.id)
  }
}

export function listCollections(): Collection[] {
  const rows = db.prepare('SELECT * FROM collections ORDER BY name COLLATE NOCASE').all() as any[]
  return rows.map(toCollection)
}

export function getCollection(id: number): Collection | null {
  const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as any
  return row ? toCollection(row) : null
}

function clean(text: unknown, max: number): string {
  return String(text ?? '').trim().slice(0, max)
}

export function createCollection(name: string, description = ''): Collection | null {
  const n = clean(name, NAME_MAX)
  if (!n) return null
  const info = db
    .prepare('INSERT INTO collections (name, description) VALUES (?, ?)')
    .run(n, clean(description, DESCRIPTION_MAX))
  return getCollection(Number(info.lastInsertRowid))
}

export function updateCollection(
  id: number,
  patch: { name?: string; description?: string; onHome?: boolean }
): Collection | null {
  const current = getCollection(id)
  if (!current) return null
  const name = patch.name === undefined ? current.name : clean(patch.name, NAME_MAX) || current.name
  const description =
    patch.description === undefined ? current.description : clean(patch.description, DESCRIPTION_MAX)
  const onHome = patch.onHome === undefined ? current.onHome : !!patch.onHome
  db.prepare('UPDATE collections SET name = ?, description = ?, on_home = ? WHERE id = ?').run(
    name,
    description,
    onHome ? 1 : 0,
    id
  )
  return getCollection(id)
}

export function deleteCollection(id: number): void {
  db.prepare('DELETE FROM collection_items WHERE collection_id = ?').run(id)
  db.prepare('DELETE FROM collections WHERE id = ?').run(id)
}

function titleExists(mediaType: 'movie' | 'show', mediaId: number): boolean {
  const table = mediaType === 'movie' ? 'movies' : 'shows'
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(mediaId)
}

export function addToCollection(id: number, mediaType: 'movie' | 'show', mediaId: number): boolean {
  if (!getCollection(id) || !titleExists(mediaType, mediaId)) return false
  const next = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM collection_items WHERE collection_id = ?')
    .get(id) as { p: number }
  db.prepare(
    `INSERT OR IGNORE INTO collection_items (collection_id, media_type, media_id, position) VALUES (?, ?, ?, ?)`
  ).run(id, mediaType, mediaId, next.p)
  return true
}

export function removeFromCollection(id: number, mediaType: 'movie' | 'show', mediaId: number): void {
  db.prepare('DELETE FROM collection_items WHERE collection_id = ? AND media_type = ? AND media_id = ?').run(
    id,
    mediaType,
    mediaId
  )
}

// Moves one title to a new place in the collection's order.
export function moveInCollection(id: number, mediaType: 'movie' | 'show', mediaId: number, toIndex: number): void {
  const items = db
    .prepare('SELECT media_type, media_id FROM collection_items WHERE collection_id = ? ORDER BY position')
    .all(id) as { media_type: string; media_id: number }[]
  const from = items.findIndex((i) => i.media_type === mediaType && i.media_id === mediaId)
  if (from < 0) return
  const [item] = items.splice(from, 1)
  items.splice(Math.max(0, Math.min(items.length, toIndex)), 0, item)
  const set = db.prepare(
    'UPDATE collection_items SET position = ? WHERE collection_id = ? AND media_type = ? AND media_id = ?'
  )
  db.transaction(() => items.forEach((it, i) => set.run(i, id, it.media_type, it.media_id)))()
}

// Which collections hold this title (the detail page's "Add to collection").
export function collectionsContaining(mediaType: 'movie' | 'show', mediaId: number): number[] {
  return (
    db
      .prepare('SELECT collection_id FROM collection_items WHERE media_type = ? AND media_id = ?')
      .all(mediaType, mediaId) as { collection_id: number }[]
  ).map((r) => r.collection_id)
}
