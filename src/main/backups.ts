import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import type { BackupInfo, BackupStatus } from '../shared/types'
import { BACKED_UP_FOLDERS, type BackupReason, backupFolderName, backupsToRemove, dailyBackupDue, parseBackupName } from './backupsCore'
import { db, deleteSetting, getSetting, setSetting } from './db'
import { logError } from './errorLog'
import { RESTORE_PENDING, RESTORE_RESULT } from './restoreOnStart'

// Server backups: the database plus game saves, profile pictures and channel
// logos, as a folder under userData/backups. Made every day, before library
// scans and app updates, and by hand from Settings; optionally copied to a
// second folder (another drive) as well. Restoring happens on a restart
// (restoreOnStart.ts).

const userData = app.getPath('userData')
const backupsDir = join(userData, 'backups')
const COPY_SUBFOLDER = 'MartBox backups'

let queue: Promise<void> = Promise.resolve()
let running = false
let lastCopy: BackupStatus['lastCopy'] = null
let lastRestore: BackupStatus['lastRestore'] = null

// How the last restore went, shown once in Settings after the restart.
try {
  const result = join(userData, RESTORE_RESULT)
  if (existsSync(result)) {
    lastRestore = JSON.parse(readFileSync(result, 'utf8'))
    rmSync(result, { force: true })
  }
} catch (err) {
  logError('backups:restoreResult', err)
}

function prune(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.partial')) rmSync(join(dir, name), { recursive: true, force: true })
  }
  for (const name of backupsToRemove(readdirSync(dir))) rmSync(join(dir, name), { recursive: true, force: true })
}

function copyToSecondFolder(name: string): void {
  const target = getSetting('backupCopyFolder')
  if (!target) return
  try {
    if (!existsSync(target)) throw new Error("The folder isn't available. Is the drive connected?")
    const dest = join(target, COPY_SUBFOLDER)
    mkdirSync(dest, { recursive: true })
    // Copied under a temporary name first, so a half-finished copy never
    // looks like a backup.
    cpSync(join(backupsDir, name), join(dest, `${name}.partial`), { recursive: true })
    renameSync(join(dest, `${name}.partial`), join(dest, name))
    prune(dest)
    lastCopy = { ok: true, at: new Date().toISOString() }
  } catch (err) {
    lastCopy = { ok: false, at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) }
    logError('backups:copy', err)
  }
}

async function makeBackup(reason: Exclude<BackupReason, 'older' | 'restore'>): Promise<void> {
  mkdirSync(backupsDir, { recursive: true })
  const name = backupFolderName(new Date(), reason)
  const partial = join(backupsDir, `${name}.partial`)
  mkdirSync(partial, { recursive: true })
  // SQLite's own backup, not a file copy: a copy of a database in WAL mode
  // can miss pages not yet written back and come out inconsistent.
  await db.backup(join(partial, 'martbox.db'))
  for (const folder of BACKED_UP_FOLDERS) {
    if (existsSync(join(userData, folder))) cpSync(join(userData, folder), join(partial, folder), { recursive: true })
  }
  renameSync(partial, join(backupsDir, name))
  prune(backupsDir)
  copyToSecondFolder(name)
}

// One at a time; never throws (a failed backup mustn't stop a scan or update).
export function backupNow(reason: Exclude<BackupReason, 'older' | 'restore'>): Promise<void> {
  queue = queue.then(async () => {
    running = true
    try {
      await makeBackup(reason)
    } catch (err) {
      logError('backups:make', err)
    } finally {
      running = false
    }
  })
  return queue
}

// Checks hourly (MartBox runs for weeks at a time) and makes the day's
// backup when it's due.
export function startBackupSchedule(): void {
  const check = (): void => {
    mkdirSync(backupsDir, { recursive: true })
    if (dailyBackupDue(readdirSync(backupsDir), new Date())) void backupNow('daily')
  }
  setTimeout(check, 2 * 60 * 1000)
  setInterval(check, 60 * 60 * 1000)
}

function sizeOf(path: string): number {
  const s = statSync(path)
  if (!s.isDirectory()) return s.size
  return readdirSync(path).reduce((total, name) => total + sizeOf(join(path, name)), 0)
}

export function backupStatus(): BackupStatus {
  mkdirSync(backupsDir, { recursive: true })
  const backups: BackupInfo[] = []
  for (const name of readdirSync(backupsDir)) {
    const b = parseBackupName(name)
    if (!b) continue
    try {
      backups.push({ ...b, sizeBytes: sizeOf(join(backupsDir, name)), databaseOnly: b.reason === 'older' })
    } catch {
      // Removed while listing.
    }
  }
  backups.sort((a, b) => b.at.localeCompare(a.at))
  return { folder: backupsDir, backups, copyFolder: getSetting('backupCopyFolder'), lastCopy, lastRestore, running }
}

export function setBackupCopyFolder(folder: string | null): void {
  if (folder) setSetting('backupCopyFolder', folder)
  else deleteSetting('backupCopyFolder')
  lastCopy = null
}

// The folder a copied backup is picked from.
export function backupCopySubfolder(): string | null {
  const target = getSetting('backupCopyFolder')
  return target ? join(target, COPY_SUBFOLDER) : null
}

// A backup picked from another folder (the second copy, after a dead drive)
// is brought into the backups folder so it can be restored like any other.
export function importBackupFolder(path: string): BackupInfo {
  const name = basename(path)
  const b = parseBackupName(name)
  if (!b || b.reason === 'older' || !existsSync(join(path, 'martbox.db'))) {
    throw new Error('That folder isn’t a MartBox backup. Pick a folder inside “MartBox backups”.')
  }
  const dest = join(backupsDir, name)
  if (!existsSync(dest)) cpSync(path, dest, { recursive: true })
  return { ...b, sizeBytes: sizeOf(dest), databaseOnly: false }
}

// Restarts MartBox; the restore itself runs before the database opens.
export function restoreBackup(name: string): void {
  if (!parseBackupName(name) || !existsSync(join(backupsDir, name))) throw new Error('That backup no longer exists')
  writeFileSync(join(userData, RESTORE_PENDING), JSON.stringify({ name }))
  app.relaunch()
  app.quit()
}
