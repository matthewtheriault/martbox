import { describe, expect, it } from 'vitest'
import {
  programsBetween,
  shuffled,
  slotAt,
  slotsBetween,
  windowAt,
  type ScheduleItem
} from './channelSchedule'

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

describe('time blocks', () => {
  // Cartoons 7:00–11:00 local time; the normal lineup otherwise.
  const cartoons = [{ mediaType: 'episode' as const, mediaId: 100, seconds: 600 }]
  const blocks = [{ startMinute: 7 * 60, endMinute: 11 * 60, items: cartoons }]
  const at = (h: number, m = 0): number => {
    const d = new Date(2026, 5, 10)
    d.setHours(h, m, 0, 0)
    return d.getTime()
  }

  it('knows which window a moment is in', () => {
    expect(windowAt(blocks, at(8)).block).toBe(0)
    expect(windowAt(blocks, at(8))).toMatchObject({ start: at(7), end: at(11) })
    const evening = windowAt(blocks, at(20))
    expect(evening.block).toBe(-1)
    expect(evening.start).toBe(at(11))
    expect(evening.end).toBe(at(7) + 24 * 3600_000)
  })

  it('handles a block that runs past midnight', () => {
    const late = [{ startMinute: 22 * 60, endMinute: 2 * 60, items: cartoons }]
    expect(windowAt(late, at(23)).block).toBe(0)
    expect(windowAt(late, at(1)).block).toBe(0)
    expect(windowAt(late, at(3)).block).toBe(-1)
  })

  it('cuts programs at block boundaries, back to back', () => {
    const programs = programsBetween(items, blocks, epoch, at(6), at(12))
    expect(programs[0].block).toBe(-1)
    const firstCartoon = programs.findIndex((p) => p.block === 0)
    expect(programs[firstCartoon].start).toBe(at(7))
    expect(programs[firstCartoon - 1].end).toBe(at(7))
    expect(programs.filter((p) => p.block === 0).every((p) => p.start >= at(7) && p.end <= at(11))).toBe(true)
    for (let i = 1; i < programs.length; i++) expect(programs[i].start).toBe(programs[i - 1].end)
    expect(programs[programs.length - 1].end).toBeGreaterThanOrEqual(at(12))
  })
})
