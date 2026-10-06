// Names and housekeeping for server backups (backups.ts). Each backup is a
// folder named after when and why it was made, e.g.
// "2026-10-06T01-23-45-678Z-daily". Backups from before 0.21 are single
// files, "martbox-<stamp>.db" (database only). Pure, so it's tested without
// touching the disk (backupsCore.test.ts).

// Besides the database, the folders people's own things live in (under the
// app's data folder): game saves, profile pictures and uploaded channel logos.
export const BACKED_UP_FOLDERS = ['game-saves', 'avatars', 'images-cache/channel-logos']

export type BackupReason = 'daily' | 'scan' | 'update' | 'manual' | 'restore' | 'older'

export interface BackupName {
  name: string
  // ISO time it was made.
  at: string
  reason: BackupReason
}

const STAMP = String.raw`(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z`
const FOLDER = new RegExp(`^${STAMP}-(daily|scan|update|manual|restore)$`)
const OLD_FILE = new RegExp(`^martbox-${STAMP}\\.db$`)

// What's kept of each kind: a week of dailies, the last few before scans,
// updates and by hand, and the copies taken just before a restore.
export const KEEP: Record<'daily' | 'restore' | 'other', number> = { daily: 7, restore: 3, other: 5 }

export function backupFolderName(date: Date, reason: Exclude<BackupReason, 'older'>): string {
  return `${date.toISOString().replace(/[:.]/g, '-')}-${reason}`
}

export function parseBackupName(name: string): BackupName | null {
  const folder = FOLDER.exec(name)
  const old = folder ? null : OLD_FILE.exec(name)
  const m = folder ?? old
  if (!m) return null
  return {
    name,
    at: `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`,
    reason: folder ? (folder[6] as BackupReason) : 'older'
  }
}

function group(reason: BackupReason): keyof typeof KEEP {
  return reason === 'daily' || reason === 'restore' ? reason : 'other'
}

// The backups past what's kept, oldest first. Names that aren't backups are
// never touched.
export function backupsToRemove(names: string[]): string[] {
  const parsed = names.map(parseBackupName).filter((b): b is BackupName => b !== null)
  parsed.sort((a, b) => b.at.localeCompare(a.at))
  const seen: Record<keyof typeof KEEP, number> = { daily: 0, restore: 0, other: 0 }
  const remove: string[] = []
  for (const b of parsed) {
    const g = group(b.reason)
    seen[g]++
    if (seen[g] > KEEP[g]) remove.push(b.name)
  }
  return remove.reverse()
}

// A daily backup is due when there's none from the last 23 hours (a little
// under a day, so it doesn't drift later each day).
export function dailyBackupDue(names: string[], now: Date): boolean {
  const last = names
    .map(parseBackupName)
    .filter((b): b is BackupName => b?.reason === 'daily')
    .map((b) => Date.parse(b.at))
    .sort((a, b) => b - a)[0]
  return last === undefined || now.getTime() - last >= 23 * 60 * 60 * 1000
}
