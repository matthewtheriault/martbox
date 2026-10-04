import { describe, expect, it } from 'vitest'
import { checkAlerts, currentAlerts, findProblems } from './alerts'
import type { DashboardSnapshot, DashboardStream } from '../shared/types'

function snapshot(overrides: {
  currentMbps?: number
  capacity?: number | null
  streams?: Partial<DashboardStream>[]
  relayed?: boolean
  diskFree?: number
}): DashboardSnapshot {
  return {
    streams: (overrides.streams ?? []).map((s, i) => ({ key: `k${i}`, title: 'Film', deviceName: 'iPhone', ...s }) as DashboardStream),
    network: {
      samples: [],
      currentMbps: overrides.currentMbps ?? 0,
      uploadCapacityMbps: overrides.capacity ?? null,
      devices: [
        {
          deviceId: 1,
          deviceName: "Alex's Fire TV",
          profileName: 'Alex',
          path: overrides.relayed ? 'relayed' : 'direct',
          online: true,
          speedMbps: null,
          latencyMs: null,
          speedTestedAt: null,
          lastSeenAt: null,
          bytesToday: 0,
          mbps: 5
        }
      ]
    },
    hardware: {
      cpuModel: '',
      cpuPercent: 0,
      memoryUsedBytes: 0,
      memoryTotalBytes: 0,
      encoder: '',
      decoder: '',
      conversionsRunning: 0,
      disks: [{ label: 'Movies', path: '/m', freeBytes: overrides.diskFree ?? 500e9, totalBytes: 4000e9 }]
    },
    alerts: []
  }
}

describe('alerts', () => {
  it('finds each kind of problem', () => {
    expect([...findProblems(snapshot({})).keys()]).toEqual([])
    expect(findProblems(snapshot({ currentMbps: 470, capacity: 500 })).has('upload')).toBe(true)
    expect(findProblems(snapshot({ currentMbps: 400, capacity: 500 })).has('upload')).toBe(false)
    const slow = snapshot({
      streams: [{ conversion: { kind: 'transcode', height: 1080, running: true, speed: 0.8, fps: 19 } }]
    })
    expect(findProblems(slow).get('slow:k0')?.message).toContain('0.8× real time')
    expect(findProblems(snapshot({ relayed: true })).has('relay:1')).toBe(true)
    expect(findProblems(snapshot({ diskFree: 100e9 })).has('disk:/m')).toBe(true)
  })

  it('raises a problem only once it is seen twice in a row, and notifies once', () => {
    const bad = snapshot({ currentMbps: 480, capacity: 500 })
    expect(checkAlerts(bad, 1000)).toEqual([])
    expect(checkAlerts(bad, 31_000).map((a) => a.key)).toEqual(['upload'])
    expect(checkAlerts(bad, 61_000)).toEqual([])
    expect(currentAlerts().map((a) => a.key)).toEqual(['upload'])
  })
})
