import { app } from 'electron'
import { getSetting, setSetting } from './db'
import type { UpdateCheckResult } from '../shared/types'

// Deliberately not electron-updater: no publish infra is set up for this
// build yet. Instead the host can point this at any static JSON file they
// control — {"version": "0.1.1", "url": "https://...", "notes": "..."} —
// and MartBox just tells them a newer version exists; the actual download
// happens in the browser.
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function getUpdateCheckUrl(): string | null {
  return getSetting('updateCheckUrl')
}

export function setUpdateCheckUrl(url: string): void {
  setSetting('updateCheckUrl', url)
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  const url = getUpdateCheckUrl()
  if (!url) {
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: null,
      downloadUrl: null,
      notes: null
    }
  }

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Update check failed (${res.status})`)
  const data = (await res.json()) as { version?: string; url?: string; notes?: string }
  if (!data.version || !data.url) {
    throw new Error('Malformed update manifest (expected { version, url })')
  }
  if (!/^https?:\/\//i.test(data.url)) {
    throw new Error('Update manifest download URL must be http(s)')
  }

  return {
    updateAvailable: compareVersions(data.version, currentVersion) > 0,
    currentVersion,
    latestVersion: data.version,
    downloadUrl: data.url,
    notes: data.notes ?? null
  }
}
