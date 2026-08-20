import Database from 'better-sqlite3'
import { app, safeStorage } from 'electron'
import { join } from 'path'
import { mkdirSync, readdirSync, unlinkSync } from 'fs'
import { logError } from './errorLog'

mkdirSync(app.getPath('userData'), { recursive: true })
const dbPath = join(app.getPath('userData'), 'martbox.db')

export const db: Database.Database = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const backupsDir = join(app.getPath('userData'), 'backups')
mkdirSync(backupsDir, { recursive: true })
const MAX_BACKUPS = 5

// A rescan runs a lot of merge/dedup/delete logic against this DB — cheap
// insurance to have a pre-scan snapshot to fall back to if a scan ever does
// something unwanted. Uses SQLite's own backup API (via better-sqlite3)
// rather than copying the file directly, since a raw copy of a WAL-mode
// database can miss not-yet-checkpointed pages and grab an inconsistent
// snapshot; db.backup() handles that correctly while the DB stays open.
export async function backupDatabase(): Promise<void> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await db.backup(join(backupsDir, `martbox-${stamp}.db`))

    const backups = readdirSync(backupsDir)
      .filter((f) => f.startsWith('martbox-') && f.endsWith('.db'))
      .sort()
    for (const stale of backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS))) {
      unlinkSync(join(backupsDir, stale))
    }
  } catch (err) {
    logError('backupDatabase', err)
  }
}

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

  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    avatar_id TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_admin INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS watch_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'episode')),
    media_id INTEGER NOT NULL,
    position_seconds REAL NOT NULL DEFAULT 0,
    duration_seconds REAL NOT NULL DEFAULT 0,
    watched INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(profile_id, media_type, media_id)
  );

  CREATE TABLE IF NOT EXISTS iptv_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tvg_id TEXT,
    name TEXT NOT NULL,
    logo_url TEXT,
    group_title TEXT,
    stream_url TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    is_dead INTEGER NOT NULL DEFAULT 0,
    checked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'show')),
    media_id INTEGER NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(profile_id, media_type, media_id)
  );

  CREATE TABLE IF NOT EXISTS iptv_programmes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_tvg_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    start_at TEXT NOT NULL,
    stop_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_episodes_show ON episodes(show_id);
  CREATE INDEX IF NOT EXISTS idx_watch_progress_updated ON watch_progress(updated_at);
  CREATE INDEX IF NOT EXISTS idx_iptv_channels_tvg_id ON iptv_channels(tvg_id);
  CREATE INDEX IF NOT EXISTS idx_iptv_programmes_channel ON iptv_programmes(channel_tvg_id, start_at);
`)

function migrateWatchProgressForProfiles(): void {
  const cols = db.prepare('PRAGMA table_info(watch_progress)').all() as { name: string }[]
  if (cols.some((c) => c.name === 'profile_id')) return

  const migrate = db.transaction(() => {
    const rowCount = (
      db.prepare('SELECT COUNT(*) as c FROM watch_progress').get() as { c: number }
    ).c

    let defaultProfileId: number | null = null
    if (rowCount > 0) {
      defaultProfileId = db
        .prepare("INSERT INTO profiles (name, avatar_id) VALUES ('Home', 'default')")
        .run().lastInsertRowid as number
    }

    db.exec(`
      CREATE TABLE watch_progress_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'episode')),
        media_id INTEGER NOT NULL,
        position_seconds REAL NOT NULL DEFAULT 0,
        duration_seconds REAL NOT NULL DEFAULT 0,
        watched INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(profile_id, media_type, media_id)
      );
    `)

    if (rowCount > 0 && defaultProfileId !== null) {
      db.prepare(
        `INSERT INTO watch_progress_new
           (id, profile_id, media_type, media_id, position_seconds, duration_seconds, watched, updated_at)
         SELECT id, ?, media_type, media_id, position_seconds, duration_seconds, watched, updated_at
         FROM watch_progress`
      ).run(defaultProfileId)
    }

    db.exec('DROP TABLE watch_progress;')
    db.exec('ALTER TABLE watch_progress_new RENAME TO watch_progress;')
    db.exec('CREATE INDEX IF NOT EXISTS idx_watch_progress_updated ON watch_progress(updated_at);')
    db.exec('CREATE INDEX IF NOT EXISTS idx_watch_progress_profile ON watch_progress(profile_id);')
  })

  migrate()
}

migrateWatchProgressForProfiles()
db.exec('CREATE INDEX IF NOT EXISTS idx_watch_progress_profile ON watch_progress(profile_id);')

function migrateProfilesForAdmin(): void {
  const cols = db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'is_admin')) {
    db.exec('ALTER TABLE profiles ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0')
  }
  // Existing installs upgrading from before this column existed have no
  // admin yet — promote whoever was created first so the feature isn't
  // dead on arrival for people who already have profiles.
  const hasAdmin = db.prepare('SELECT 1 FROM profiles WHERE is_admin = 1 LIMIT 1').get()
  if (!hasAdmin) {
    db.exec('UPDATE profiles SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM profiles)')
  }
}

migrateProfilesForAdmin()

function migrateProfilesForPin(): void {
  const cols = db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'pin')) {
    db.exec('ALTER TABLE profiles ADD COLUMN pin TEXT')
  }
}

migrateProfilesForPin()

function migrateMediaForGenresAndCollections(): void {
  const movieCols = db.prepare('PRAGMA table_info(movies)').all() as { name: string }[]
  if (!movieCols.some((c) => c.name === 'genres')) {
    db.exec('ALTER TABLE movies ADD COLUMN genres TEXT')
  }
  if (!movieCols.some((c) => c.name === 'collection_id')) {
    db.exec('ALTER TABLE movies ADD COLUMN collection_id INTEGER')
    db.exec('ALTER TABLE movies ADD COLUMN collection_name TEXT')
    db.exec('ALTER TABLE movies ADD COLUMN collection_poster_path TEXT')
  }

  const showCols = db.prepare('PRAGMA table_info(shows)').all() as { name: string }[]
  if (!showCols.some((c) => c.name === 'genres')) {
    db.exec('ALTER TABLE shows ADD COLUMN genres TEXT')
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_movies_collection ON movies(collection_id)')
}

migrateMediaForGenresAndCollections()

function migrateMediaForCastCrewTrailer(): void {
  for (const table of ['movies', 'shows']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === 'cast_json')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN cast_json TEXT`)
    }
    if (!cols.some((c) => c.name === 'crew_json')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN crew_json TEXT`)
    }
    if (!cols.some((c) => c.name === 'trailer_key')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN trailer_key TEXT`)
    }
  }
}

migrateMediaForCastCrewTrailer()

function migrateIptvChannelsForHealth(): void {
  const cols = db.prepare('PRAGMA table_info(iptv_channels)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'is_dead')) {
    db.exec('ALTER TABLE iptv_channels ADD COLUMN is_dead INTEGER NOT NULL DEFAULT 0')
  }
  if (!cols.some((c) => c.name === 'checked_at')) {
    db.exec('ALTER TABLE iptv_channels ADD COLUMN checked_at TEXT')
  }
}

migrateIptvChannelsForHealth()

function migrateProfilesForSeenAt(): void {
  const cols = db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'movies_seen_at')) {
    db.exec('ALTER TABLE profiles ADD COLUMN movies_seen_at TEXT')
  }
  if (!cols.some((c) => c.name === 'shows_seen_at')) {
    db.exec('ALTER TABLE profiles ADD COLUMN shows_seen_at TEXT')
  }
}

migrateProfilesForSeenAt()

// Lets updateMovie mark a title as user-set so registerMovieFile's rescan
// bookkeeping never overwrites it, even for a movie that has no tmdb_id yet.
function migrateMoviesForTitleLock(): void {
  const cols = db.prepare('PRAGMA table_info(movies)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'title_locked')) {
    db.exec('ALTER TABLE movies ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0')
  }
}

migrateMoviesForTitleLock()

// Same as migrateMoviesForTitleLock, for shows — lets updateShow mark a
// title as user-set so a rescan's automatic re-match step
// (scanAndMatchLibrary) never overwrites it, even for a show with no
// tmdb_id yet.
function migrateShowsForTitleLock(): void {
  const cols = db.prepare('PRAGMA table_info(shows)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'title_locked')) {
    db.exec('ALTER TABLE shows ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0')
  }
}

migrateShowsForTitleLock()

// Lets mergeShows tombstone a folded-away show (point it at the show it was
// merged into) instead of deleting its row outright. A rescan re-derives
// show groupings purely from folder/file names on disk with no memory of
// past merges — without this redirect left behind, the next rescan of a
// merged-away folder would recreate it as a fresh duplicate show and pull
// its episodes right back off the show it was merged into.
function migrateShowsForMergeRedirect(): void {
  const cols = db.prepare('PRAGMA table_info(shows)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'merged_into_id')) {
    db.exec('ALTER TABLE shows ADD COLUMN merged_into_id INTEGER REFERENCES shows(id)')
  }
}

migrateShowsForMergeRedirect()

// Idempotent — covers installs that already have every other table but
// predate the watchlist feature (CREATE TABLE up top only runs on a
// brand-new database file).
db.exec(`
  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'show')),
    media_id INTEGER NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(profile_id, media_type, media_id)
  );
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

export function deleteSetting(key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key)
}

// Shared OS-keychain encryption (Electron safeStorage) for any secret that
// needs to be stored at rest but read back in cleartext later — the
// Tailscale API token, and profile PINs. The stored value is meaningless
// outside this machine/user account.
export function encryptValue(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level encryption is not available on this machine')
  }
  return safeStorage.encryptString(value).toString('base64')
}

export function decryptValue(stored: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return null
  }
}

// For secrets (e.g. the Tailscale API token) rather than plain settings like
// tmdbApiKey.
export function encryptedGetSetting(key: string): string | null {
  const stored = getSetting(key)
  return stored === null ? null : decryptValue(stored)
}

export function encryptedSetSetting(key: string, value: string): void {
  setSetting(key, encryptValue(value))
}
