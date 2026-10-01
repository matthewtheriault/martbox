import { listIptvChannelsForHealthCheck, setIptvChannelHealth } from './repository'
import type { IptvHealthProgress } from '../shared/types'

const CONCURRENCY = 15
const TIMEOUT_MS = 7000

let running = false

export function isHealthCheckRunning(): boolean {
  return running
}

async function checkOne(streamUrl: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(streamUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'MartBox/1.0' }
    })
    // Not interested in the body — a public IPTV source failing is almost
    // always a non-2xx status, a timeout, or a connection error, all of
    // which are cheap to detect from the response headers alone. Reading
    // the full body for every one of a list that can run into the
    // thousands would make this take far too long to be worth running
    // automatically after every playlist refresh.
    res.body?.cancel().catch(() => {})
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function verifyChannels(
  onProgress: (p: IptvHealthProgress) => void
): Promise<void> {
  if (running) return
  running = true
  try {
    const channels = listIptvChannelsForHealthCheck()
    const total = channels.length
    let current = 0
    let dead = 0
    let nextIndex = 0

    const worker = async (): Promise<void> => {
      while (nextIndex < channels.length) {
        const channel = channels[nextIndex++]
        const alive = await checkOne(channel.streamUrl)
        setIptvChannelHealth(channel.id, !alive)
        current++
        if (!alive) dead++
        // Throttled — thousands of individual IPC sends would flood the
        // renderer for no benefit the UI could actually show per-tick.
        if (current % 25 === 0 || current === total) {
          onProgress({ current, total, dead, done: false })
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker))
    onProgress({ current: total, total, dead, done: true })
  } finally {
    running = false
  }
}
