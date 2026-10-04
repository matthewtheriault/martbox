import type { DashboardAlert, DashboardSnapshot } from '../shared/types'

// Dashboard alerts (v3): things the admin should know about right now. They
// show in the Dashboard and, once per problem every few hours, as a desktop
// notification on the server PC. Checked every 30 s from the same snapshot
// the Dashboard shows; a problem has to be seen twice in a row before it's
// raised, so a brief spike doesn't alert.

const KEEP_MS = 60 * 60 * 1000
const NOTIFY_AGAIN_MS = 6 * 60 * 60 * 1000

const seenOnce = new Set<string>()
const alerts = new Map<string, DashboardAlert>()
const notifiedAt = new Map<string, number>()

function gb(bytes: number): string {
  return `${Math.round(bytes / 1e9)} GB`
}

// The problems in a snapshot, by key.
export function findProblems(snapshot: DashboardSnapshot): Map<string, Omit<DashboardAlert, 'at'>> {
  const found = new Map<string, Omit<DashboardAlert, 'at'>>()
  const { network, streams, hardware } = snapshot
  const capacity = network.uploadCapacityMbps
  if (capacity && network.currentMbps > capacity * 0.9) {
    found.set('upload', {
      key: 'upload',
      level: 'problem',
      message:
        `Upload nearly full: ${Math.round(network.currentMbps)} of ${capacity} Mbps in use. ` +
        'New streams will get lower quality.'
    })
  }
  for (const stream of streams) {
    const c = stream.conversion
    if (c && c.kind === 'transcode' && c.running && c.speed !== null && c.speed < 1) {
      found.set(`slow:${stream.key}`, {
        key: `slow:${stream.key}`,
        level: 'problem',
        message:
          `Converting ${stream.title} for ${stream.deviceName} is too slow ` +
          `(${c.speed.toFixed(1)}× real time) — it will buffer.`
      })
    }
  }
  for (const device of network.devices) {
    if (device.path === 'relayed' && device.mbps > 0.5) {
      found.set(`relay:${device.deviceId}`, {
        key: `relay:${device.deviceId}`,
        level: 'warning',
        message:
          `${device.deviceName} is going through Tailscale's relay, which is slow — ` +
          'their network is blocking a direct connection.'
      })
    }
  }
  for (const disk of hardware.disks) {
    if (disk.totalBytes > 0 && disk.freeBytes / disk.totalBytes < 0.1) {
      found.set(`disk:${disk.path}`, {
        key: `disk:${disk.path}`,
        level: 'warning',
        message:
          `${disk.label} drive nearly full: ` +
          `${gb(disk.freeBytes)} free of ${gb(disk.totalBytes)}.`
      })
    }
  }
  return found
}

// Returns the alerts that just became active (for notifications).
export function checkAlerts(snapshot: DashboardSnapshot, now = Date.now()): DashboardAlert[] {
  const found = findProblems(snapshot)
  const raised: DashboardAlert[] = []
  for (const [key, problem] of found) {
    if (!seenOnce.has(key)) {
      seenOnce.add(key)
      continue
    }
    const alert = { ...problem, at: now }
    alerts.set(key, alert)
    const last = notifiedAt.get(key)
    if (last === undefined || now - last > NOTIFY_AGAIN_MS) {
      notifiedAt.set(key, now)
      raised.push(alert)
    }
  }
  for (const key of [...seenOnce]) if (!found.has(key)) seenOnce.delete(key)
  for (const [key, alert] of [...alerts]) {
    if (!found.has(key) && now - alert.at > KEEP_MS) alerts.delete(key)
  }
  return raised
}

export function currentAlerts(): DashboardAlert[] {
  return [...alerts.values()].sort((a, b) => b.at - a.at)
}
