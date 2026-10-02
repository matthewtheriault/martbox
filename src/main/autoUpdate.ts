import { app, Notification } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { backupDatabase } from './db'
import { logError } from './errorLog'
import type { AppUpdateStatus } from '../shared/types'

// Updates come from GitHub Releases on the public repo (see the `publish`
// block in electron-builder.yml and docs/RELEASING.md). Each release carries
// latest.yml (Windows) / latest-mac.yml (macOS), which electron-updater
// reads to find, download and verify the new build. User data lives in
// userData, outside the app bundle, so installing an update never touches it
// — and a DB backup is taken as soon as an update finishes downloading,
// before anything gets the chance to install it.

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 15 * 1000

// Dev runs have no app-update.yml, and Mac App Store builds update through
// the App Store — electron-updater must stay out of both.
const supported = app.isPackaged && !process.mas

let status: AppUpdateStatus = {
  state: supported ? 'idle' : 'unsupported',
  currentVersion: app.getVersion(),
  latestVersion: null,
  releaseNotes: null,
  progressPercent: null,
  error: null,
  checkedAt: null
}

const listeners = new Set<(status: AppUpdateStatus) => void>()

function setStatus(patch: Partial<AppUpdateStatus>): void {
  status = { ...status, ...patch }
  for (const listener of listeners) listener(status)
}

export function getUpdateStatus(): AppUpdateStatus {
  return status
}

export function onUpdateStatus(listener: (status: AppUpdateStatus) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// GitHub release notes arrive as HTML; the Settings page shows plain text.
function notesText(info: UpdateInfo): string | null {
  const raw = Array.isArray(info.releaseNotes)
    ? info.releaseNotes.map((n) => n.note ?? '').join('\n\n')
    : info.releaseNotes
  if (!raw) return null
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// The Windows installer is built and attached by CI, the Mac build is
// uploaded separately — for a few minutes a release can exist without this
// platform's update file. That's "nothing for us yet", not an error.
function isMissingPlatformAsset(err: Error): boolean {
  return /latest(-mac)?\.yml|404|Cannot find channel/i.test(err.message)
}

export function initAutoUpdates(): void {
  if (!supported) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    setStatus({ state: 'checking', error: null })
  })
  autoUpdater.on('update-not-available', () => {
    setStatus({
      state: 'up-to-date',
      latestVersion: app.getVersion(),
      progressPercent: null,
      checkedAt: new Date().toISOString()
    })
  })
  autoUpdater.on('update-available', (info) => {
    setStatus({
      state: 'downloading',
      latestVersion: info.version,
      releaseNotes: notesText(info),
      progressPercent: 0,
      checkedAt: new Date().toISOString()
    })
  })
  autoUpdater.on('download-progress', (progress) => {
    setStatus({ progressPercent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', async (info) => {
    await backupDatabase()
    setStatus({
      state: 'ready',
      latestVersion: info.version,
      releaseNotes: notesText(info),
      progressPercent: 100
    })
    if (Notification.isSupported()) {
      new Notification({
        title: `MartBox ${info.version} is ready`,
        body: 'Restart MartBox to install the update. Your libraries and settings are kept.'
      }).show()
    }
  })
  autoUpdater.on('error', (err) => {
    if (isMissingPlatformAsset(err)) {
      setStatus({
        state: 'up-to-date',
        progressPercent: null,
        checkedAt: new Date().toISOString()
      })
      return
    }
    logError('autoUpdater', err)
    setStatus({ state: 'error', error: err.message, progressPercent: null })
  })

  setTimeout(checkForUpdatesNow, FIRST_CHECK_DELAY_MS)
  setInterval(checkForUpdatesNow, CHECK_INTERVAL_MS)
}

export function checkForUpdatesNow(): void {
  if (!supported) return
  // A downloaded update stays ready until it's installed — re-checking would
  // only re-download the same thing.
  if (status.state === 'ready' || status.state === 'downloading') return
  autoUpdater.checkForUpdates().catch((err) => {
    // Also surfaced through the 'error' event above.
    logError('checkForUpdates', err)
  })
}

export async function installUpdateNow(): Promise<void> {
  if (status.state !== 'ready') return
  await backupDatabase()
  // isSilent=false shows the Windows installer's progress; isForceRunAfter
  // relaunches MartBox once the install finishes.
  autoUpdater.quitAndInstall(false, true)
}
