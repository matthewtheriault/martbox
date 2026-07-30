import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'

mkdirSync(app.getPath('userData'), { recursive: true })
const dbPath = join(app.getPath('userData'), 'ovrlook.db')

export const db: Database.Database = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS libraries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('movie', 'tv')),
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    file_path TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    sort_title TEXT NOT NULL,
    year INTEGER,
    tmdb_id INTEGER,
    overview TEXT,
    poster_path TEXT,
    backdrop_path TEXT,
    rating REAL,
    runtime_minutes INTEGER,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS shows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    folder_path TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    sort_title TEXT NOT NULL,
    year INTEGER,
    tmdb_id INTEGER,
    overview TEXT,
    poster_path TEXT,
    backdrop_path TEXT,
    rating REAL,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    season_number INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    file_path TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    overview TEXT,
    still_path TEXT,
    air_date TEXT,
    duration_seconds REAL,
    UNIQUE(show_id, season_number, episode_number)
  );

  CREATE TABLE IF NOT EXISTS watch_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'episode')),
    media_id INTEGER NOT NULL,
    position_seconds REAL NOT NULL DEFAULT 0,
    duration_seconds REAL NOT NULL DEFAULT 0,
    watched INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(media_type, media_id)
  );

  CREATE INDEX IF NOT EXISTS idx_episodes_show ON episodes(show_id);
  CREATE INDEX IF NOT EXISTS idx_watch_progress_updated ON watch_progress(updated_at);
`)

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}
