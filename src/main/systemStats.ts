import { cpus, freemem, totalmem } from 'os'
import { statfsSync } from 'fs'

// CPU, memory and disk space for the dashboard's Hardware panel — plain
// Node, no extra tools or admin rights. GPU load and temperatures need
// vendor tools or elevated access on Windows, so they're left out.

let lastCpu = cpuTimes()
let cpuPercent = 0

function cpuTimes(): { idle: number; total: number } {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

// Sampled every few seconds; the dashboard reads the latest.
setInterval(() => {
  const now = cpuTimes()
  const total = now.total - lastCpu.total
  const idle = now.idle - lastCpu.idle
  cpuPercent = total > 0 ? Math.round((1 - idle / total) * 100) : 0
  lastCpu = now
}, 3000).unref()

export interface CpuMemory {
  cpuModel: string
  cpuPercent: number
  memoryUsedBytes: number
  memoryTotalBytes: number
}

export function cpuMemory(): CpuMemory {
  const total = totalmem()
  return {
    cpuModel: cpus()[0]?.model.trim() ?? '',
    cpuPercent,
    memoryUsedBytes: total - freemem(),
    memoryTotalBytes: total
  }
}

export interface DiskSpace {
  label: string
  path: string
  freeBytes: number
  totalBytes: number
}

// Free space where each folder lives; folders on the same drive are shown
// once, with their labels joined.
export function diskSpace(folders: { label: string; path: string }[]): DiskSpace[] {
  const byDrive = new Map<string, DiskSpace>()
  for (const folder of folders) {
    try {
      const stats = statfsSync(folder.path)
      const totalBytes = stats.blocks * stats.bsize
      const freeBytes = stats.bavail * stats.bsize
      const key = `${totalBytes}:${stats.type}`
      const existing = byDrive.get(key)
      if (existing) {
        if (!existing.label.split(', ').includes(folder.label)) {
          existing.label += `, ${folder.label}`
        }
      } else {
        byDrive.set(key, { label: folder.label, path: folder.path, freeBytes, totalBytes })
      }
    } catch {
      /* missing or unplugged drive: left out */
    }
  }
  return [...byDrive.values()]
}
