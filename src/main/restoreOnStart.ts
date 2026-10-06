import Database from 'better-sqlite3'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BACKED_UP_FOLDERS, backupFolderName, parseBackupName } from './backupsCore'

// Restoring a backup swaps the database file, which can't happen while it's
// open — so Settings leaves a note (restore-pending.json) and restarts
// MartBox, and this runs first thing, before db.ts opens the database.
// What's there now is kept as a "restore" backup first, so a restore can be
// undone. The outcome is left in restore-result.json for Settings to show.

export const RESTORE_PENDING = 'restore-pending.json'
export const RESTORE_RESULT = 'restore-result.json'

export function applyPendingRestore(userData: string): void {
  const marker = join(userData, RESTORE_PENDING)
  if (!existsSync(marker)) return
  const backupsDir = join(userData, 'backups')
  let name = ''
  try {
    name = String(JSON.parse(readFileSync(marker, 'utf8')).name ?? '')
    const backup = parseBackupName(name)
    if (!backup) throw new Error('Not a MartBox backup')
    const source = join(backupsDir, name)
    const sourceDb = backup.reason === 'older' ? source : join(source, 'martbox.db')
    if (!existsSync(sourceDb)) throw new Error('The backup is missing')

    // Keep what's here now.
    const dbPath = join(userData, 'martbox.db')
    const safety = join(backupsDir, backupFolderName(new Date(), 'restore'))
    mkdirSync(safety, { recursive: true })
    if (existsSync(dbPath)) {
      try {
        // Folds the write-ahead log into the file, so the one file is complete.
        const current = new Database(dbPath)
        current.pragma('wal_checkpoint(TRUNCATE)')
        current.close()
      } catch {
        // A damaged database: copy it as it is.
      }
      copyFileSync(dbPath, join(safety, 'martbox.db'))
    }
    for (const folder of BACKED_UP_FOLDERS) {
      if (existsSync(join(userData, folder))) cpSync(join(userData, folder), join(safety, folder), { recursive: true })
    }

    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true })
    copyFileSync(sourceDb, dbPath)
    // Backups from before 0.21 hold only the database: leave the folders be.
    if (backup.reason !== 'older') {
      for (const folder of BACKED_UP_FOLDERS) {
        rmSync(join(userData, folder), { recursive: true, force: true })
        if (existsSync(join(source, folder))) cpSync(join(source, folder), join(userData, folder), { recursive: true })
      }
    }
    writeFileSync(join(userData, RESTORE_RESULT), JSON.stringify({ ok: true, name, at: backup.at }))
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    writeFileSync(join(userData, RESTORE_RESULT), JSON.stringify({ ok: false, name, error }))
  } finally {
    rmSync(marker, { force: true })
  }
}
