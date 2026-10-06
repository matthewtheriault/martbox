import { describe, expect, it } from 'vitest'
import { peakKbps } from './mkvKeyframes'

// Index points: a keyframe's time (s) and where its cluster starts (bytes).
const steady = (mbps: number, seconds: number): { time: number; pos: number }[] =>
  Array.from({ length: seconds / 2 + 1 }, (_, i) => ({ time: i * 2, pos: (i * 2 * mbps * 1e6) / 8 }))

describe('peak bitrate from the MKV index', () => {
  it('is the average for a steady file', () => {
    expect(peakKbps(steady(8, 60))).toBe(8000)
  })

  it('finds a busy stretch', () => {
    // 8 Mbps, except 20 s at 30 Mbps in the middle.
    const points: { time: number; pos: number }[] = []
    let pos = 0
    for (let t = 0; t <= 120; t += 2) {
      points.push({ time: t, pos })
      pos += ((t >= 50 && t < 70 ? 30 : 8) * 1e6 * 2) / 8
    }
    expect(peakKbps(points)).toBe(30000)
  })

  it('needs at least one full window', () => {
    expect(peakKbps(steady(8, 6))).toBeNull()
    expect(peakKbps([])).toBeNull()
  })
})
