import { describe, expect, it } from 'vitest'
import { shuffled, slotAt, slotsBetween, type ScheduleItem } from './channelSchedule'

const items: ScheduleItem[] = [
  { mediaType: 'episode', mediaId: 1, seconds: 1200 },
  { mediaType: 'episode', mediaId: 2, seconds: 1300 },
  { mediaType: 'movie', mediaId: 3, seconds: 5400 }
]
const epoch = Date.UTC(2026, 0, 1)
const cycle = (1200 + 1300 + 5400) * 1000

describe('slotAt', () => {
  it('finds what is on from the clock alone', () => {
    expect(slotAt(items, epoch, epoch)).toEqual({ index: 0, start: epoch, end: epoch + 1200_000 })
    expect(slotAt(items, epoch, epoch + 1250_000)).toEqual({
      index: 1,
      start: epoch + 1200_000,
      end: epoch + 2500_000
    })
    expect(slotAt(items, epoch, epoch + 2500_000)?.index).toBe(2)
  })

  it('repeats the cycle forever, and before the epoch too', () => {
    expect(slotAt(items, epoch, epoch + 3 * cycle + 1250_000)?.index).toBe(1)
    expect(slotAt(items, epoch, epoch + 3 * cycle + 1250_000)?.start).toBe(epoch + 3 * cycle + 1200_000)
    expect(slotAt(items, epoch, epoch - 1000)?.index).toBe(2)
  })

  it('has nothing for an empty channel', () => {
    expect(slotAt([], epoch, epoch)).toBeNull()
  })
})

describe('slotsBetween', () => {
  it('lists programs back to back across the window, wrapping the cycle', () => {
    const slots = slotsBetween(items, epoch, epoch + 2000_000, epoch + cycle + 100_000)
    expect(slots.map((s) => s.index)).toEqual([1, 2, 0])
    for (let i = 1; i < slots.length; i++) expect(slots[i].start).toBe(slots[i - 1].end)
    expect(slots[slots.length - 1].end).toBeGreaterThanOrEqual(epoch + cycle + 100_000)
  })
})

describe('shuffled', () => {
  it('is a stable permutation for a seed', () => {
    const list = Array.from({ length: 50 }, (_, i) => i)
    const a = shuffled(list, 42)
    expect(shuffled(list, 42)).toEqual(a)
    expect(shuffled(list, 43)).not.toEqual(a)
    expect([...a].sort((x, y) => x - y)).toEqual(list)
  })
})
