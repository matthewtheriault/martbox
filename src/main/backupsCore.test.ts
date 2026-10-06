import { describe, expect, it } from 'vitest'
import { backupFolderName, backupsToRemove, dailyBackupDue, parseBackupName } from './backupsCore'

const at = (day: number, hour = 3): Date => new Date(Date.UTC(2026, 9, day, hour))

describe('backup names', () => {
  it('round-trips a folder name', () => {
    const name = backupFolderName(new Date('2026-10-06T01:23:45.678Z'), 'daily')
    expect(name).toBe('2026-10-06T01-23-45-678Z-daily')
    expect(parseBackupName(name)).toEqual({ name, at: '2026-10-06T01:23:45.678Z', reason: 'daily' })
  })

  it('reads backups from before 0.21', () => {
    expect(parseBackupName('martbox-2026-09-01T10-00-00-000Z.db')).toMatchObject({ at: '2026-09-01T10:00:00.000Z', reason: 'older' })
  })

  it('ignores anything else', () => {
    for (const name of ['notes.txt', '2026-10-06T01-23-45-678Z-daily.partial', 'martbox.db', '2026-10-06-daily']) {
      expect(parseBackupName(name)).toBeNull()
    }
  })
})

describe('which backups are kept', () => {
  it('keeps a week of dailies and five others, removing the oldest', () => {
    const dailies = Array.from({ length: 9 }, (_, i) => backupFolderName(at(i + 1), 'daily'))
    const scans = Array.from({ length: 6 }, (_, i) => backupFolderName(at(i + 1, 5), 'scan'))
    const old = 'martbox-2026-09-01T10-00-00-000Z.db'
    const remove = backupsToRemove([...dailies, ...scans, old, 'notes.txt'])
    expect(remove).toEqual([old, dailies[0], scans[0], dailies[1]])
  })

  it("doesn't let scans push out the copies made before a restore", () => {
    const restore = backupFolderName(at(1), 'restore')
    const scans = Array.from({ length: 8 }, (_, i) => backupFolderName(at(i + 2), 'scan'))
    expect(backupsToRemove([restore, ...scans])).not.toContain(restore)
  })
})

describe('daily backups', () => {
  it('is due with no daily backup, or none in the last 23 hours', () => {
    expect(dailyBackupDue([backupFolderName(at(5), 'scan')], at(5, 4))).toBe(true)
    expect(dailyBackupDue([backupFolderName(at(5), 'daily')], at(5, 20))).toBe(false)
    expect(dailyBackupDue([backupFolderName(at(5), 'daily')], at(6, 2))).toBe(true)
  })
})
