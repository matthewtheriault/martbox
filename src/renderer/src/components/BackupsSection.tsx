import { useEffect, useState } from 'react'
import type { BackupInfo, BackupStatus } from '../../../shared/types'

// Settings → Backups (the server's admin only): the backups on this PC, a
// second folder to copy each one to, and restoring one.

const REASON: Record<BackupInfo['reason'], string> = {
  daily: 'Daily',
  scan: 'Before a library scan',
  update: 'Before an app update',
  manual: 'Made by hand',
  restore: 'Before a restore',
  older: 'Before a library scan (database only)'
}

// The newest few; the rest behind "Show All".
const SHOWN = 5

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function confirmRestore(b: BackupInfo): boolean {
  return window.confirm(
    `Restore the backup from ${formatWhen(b.at)}?\n\n` +
      'MartBox will restart, and anyone watching will be disconnected for a moment. ' +
      (b.databaseOnly
        ? 'Libraries, users, watch history, playlists and settings go back to how they were then.'
        : 'Libraries, users, watch history, playlists, settings, game saves and profile pictures go back to how they were then.') +
      '\n\nWhat’s here now is backed up first, so you can undo this by restoring that backup.'
  )
}

export default function BackupsSection({ profileId }: { profileId: number }): JSX.Element {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    window.api.backups.status(profileId).then(setStatus, (err) => setError(String(err?.message ?? err)))
  }, [profileId])

  const run = async (action: () => Promise<BackupStatus | void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await action()
      if (next) setStatus(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const restore = (b: BackupInfo): void => {
    if (confirmRestore(b)) void run(() => window.api.backups.restore(profileId, b.name))
  }

  const restoreFromCopy = (): void =>
    void run(async () => {
      const picked = await window.api.backups.pickFromCopyFolder(profileId)
      if (picked && confirmRestore(picked)) await window.api.backups.restore(profileId, picked.name)
    })

  if (!status) {
    return (
      <section className="settings-section">
        <h2>Backups</h2>
        {error && <p className="settings-status-error">{error}</p>}
      </section>
    )
  }

  const restored = status.lastRestore
  return (
    <section className="settings-section">
      <h2>Backups</h2>
      <p className="settings-hint">
        MartBox backs up its own data every day, and before library scans and app updates: libraries,
        users, watch history, playlists, requests, settings, game saves and profile pictures. Your
        movies, music and other files aren&apos;t included. The last week of daily backups is kept.
      </p>
      {restored &&
        (restored.ok ? (
          <p className="settings-status-ok">
            Restored the backup from {restored.at ? formatWhen(restored.at) : restored.name}.
          </p>
        ) : (
          <p className="settings-status-error">The restore didn&apos;t work: {restored.error}</p>
        ))}

      <div className="settings-row">
        <button className="btn-secondary" disabled={busy || status.running} onClick={() => run(() => window.api.backups.backUpNow(profileId))}>
          {busy || status.running ? 'Working…' : 'Back Up Now'}
        </button>
        <button className="btn-secondary" onClick={() => window.api.system.showInFolder(status.folder)}>
          Show in Folder
        </button>
      </div>

      {status.backups.length === 0 ? (
        <p className="settings-hint">No backups yet. The first one is made a couple of minutes after MartBox starts.</p>
      ) : (
        <ul className="library-list">
          {(showAll ? status.backups : status.backups.slice(0, SHOWN)).map((b) => (
            <li key={b.name} className="library-item">
              <div>
                <div className="library-name">{formatWhen(b.at)}</div>
                <div className="library-path">
                  {REASON[b.reason]} · {formatSize(b.sizeBytes)}
                </div>
              </div>
              <div className="library-actions">
                <button className="btn-secondary" disabled={busy} onClick={() => restore(b)}>
                  Restore
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!showAll && status.backups.length > SHOWN && (
        <button className="btn-secondary" onClick={() => setShowAll(true)}>
          Show All {status.backups.length}
        </button>
      )}

      <div className="settings-subsection">
        <h3>Second copy</h3>
        <p className="settings-hint">
          Backups on this PC won&apos;t help if its drive fails. Pick a folder on another drive (or a
          synced folder like OneDrive) and every backup is copied there too.
        </p>
        {status.copyFolder && <p className="settings-hint">Copying to: {status.copyFolder}</p>}
        <div className="settings-row">
          <button className="btn-secondary" disabled={busy} onClick={() => run(() => window.api.backups.chooseCopyFolder(profileId))}>
            {status.copyFolder ? 'Change Folder…' : 'Choose Folder…'}
          </button>
          {status.copyFolder && (
            <button className="btn-secondary" disabled={busy} onClick={() => run(() => window.api.backups.clearCopyFolder(profileId))}>
              Stop Copying
            </button>
          )}
          {/* Always offered: after a drive failure, MartBox starts fresh and doesn't know the folder. */}
          <button className="btn-secondary" disabled={busy} onClick={restoreFromCopy}>
            Restore from a Copy…
          </button>
        </div>
        {status.lastCopy &&
          (status.lastCopy.ok ? (
            <p className="settings-status-ok">Last copied {formatWhen(status.lastCopy.at)}.</p>
          ) : (
            <p className="settings-status-error">Couldn&apos;t copy the last backup: {status.lastCopy.error}</p>
          ))}
      </div>
      {error && <p className="settings-status-error">{error}</p>}
    </section>
  )
}
