// The maths behind Live Channels (channels.ts): a channel is a fixed list of
// items played back to back, forever, starting at a fixed moment (its
// epoch). What's on at any time is worked out from the clock alone — nothing
// runs while nobody is watching, and everyone who tunes in sees the same
// program at the same point, like real TV.

export interface ScheduleItem {
  mediaType: 'movie' | 'episode'
  mediaId: number
  seconds: number
}

export interface ScheduledSlot {
  index: number
  // Unix ms.
  start: number
  end: number
}

function cycleMs(items: ScheduleItem[]): number {
  return items.reduce((sum, item) => sum + item.seconds * 1000, 0)
}

// The item playing at time t, and when it started and ends.
export function slotAt(items: ScheduleItem[], epoch: number, t: number): ScheduledSlot | null {
  const cycle = cycleMs(items)
  if (items.length === 0 || cycle <= 0) return null
  const elapsed = t - epoch
  const cycleStart = t - (((elapsed % cycle) + cycle) % cycle)
  let start = cycleStart
  for (let index = 0; index < items.length; index++) {
    const end = start + items[index].seconds * 1000
    if (t < end) return { index, start, end }
    start = end
  }
  // Rounding at the very end of a cycle: the first item of the next one.
  return { index: 0, start, end: start + items[0].seconds * 1000 }
}

// Everything on between from and to, in order (the first one may have
// started before from).
export function slotsBetween(
  items: ScheduleItem[],
  epoch: number,
  from: number,
  to: number,
  limit = 200
): ScheduledSlot[] {
  const first = slotAt(items, epoch, from)
  if (!first) return []
  const slots = [first]
  let last = first
  while (last.end < to && slots.length < limit) {
    const index = (last.index + 1) % items.length
    last = { index, start: last.end, end: last.end + items[index].seconds * 1000 }
    slots.push(last)
  }
  return slots
}

// Deterministic shuffle (mulberry32), so a channel's order only changes when
// it's rebuilt with a new seed.
export function shuffled<T>(list: T[], seed: number): T[] {
  let state = seed >>> 0
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let x = state
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// --- Time blocks: a channel can play something else at set times of day
// ("cartoons 7–11 am"). Each block, and the channel's normal lineup, is its
// own loop from the same epoch; whichever is active at a moment decides
// what's on, cutting over at block boundaries like real TV.

export interface TimeBlock {
  // Minutes after local midnight; end ≤ start means it runs past midnight.
  startMinute: number
  endMinute: number
  items: ScheduleItem[]
}

export interface ScheduleWindow {
  // -1: the channel's normal lineup.
  block: number
  start: number
  end: number
}

const MINUTE_MS = 60_000

function localMidnight(t: number, dayOffset: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + dayOffset)
  return d.getTime()
}

// Every block window overlapping [from, to), in order.
function blockWindows(blocks: TimeBlock[], from: number, to: number): ScheduleWindow[] {
  const windows: ScheduleWindow[] = []
  for (let day = -1; ; day++) {
    const midnight = localMidnight(from, day)
    if (midnight > to) break
    blocks.forEach((b, block) => {
      const start = midnight + b.startMinute * MINUTE_MS
      const endMinute = b.endMinute <= b.startMinute ? b.endMinute + 24 * 60 : b.endMinute
      const end = midnight + endMinute * MINUTE_MS
      if (end > from && start < to) windows.push({ block, start, end })
    })
  }
  return windows.sort((a, b) => a.start - b.start)
}

// The run of time containing t: a block's window, or the gap between
// blocks where the normal lineup plays.
export function windowAt(blocks: TimeBlock[], t: number): ScheduleWindow {
  if (blocks.length === 0) return { block: -1, start: -Infinity, end: Infinity }
  const day = 24 * 60 * MINUTE_MS
  const windows = blockWindows(blocks, t - 2 * day, t + 2 * day)
  const inside = windows.find((w) => w.start <= t && t < w.end)
  if (inside) return inside
  const before = windows.filter((w) => w.end <= t).pop()
  const after = windows.find((w) => w.start > t)
  return { block: -1, start: before?.end ?? -Infinity, end: after?.start ?? Infinity }
}

export interface WindowedSlot extends ScheduledSlot {
  block: number
  // When the item itself began (start may be cut to the window).
  itemStart: number
}

// What's on between from and to across blocks: each program cut to the
// window it plays in.
export function programsBetween(
  items: ScheduleItem[],
  blocks: TimeBlock[],
  epoch: number,
  from: number,
  to: number,
  limit = 300
): WindowedSlot[] {
  const out: WindowedSlot[] = []
  let at = from
  while (at < to && out.length < limit) {
    const window = windowAt(blocks, at)
    const list = window.block === -1 ? items : blocks[window.block].items
    const until = Math.min(window.end, to)
    for (const slot of slotsBetween(list, epoch, at, until, limit)) {
      out.push({
        index: slot.index,
        block: window.block,
        itemStart: slot.start,
        start: Math.max(slot.start, window.start),
        end: Math.min(slot.end, window.end)
      })
      if (out.length >= limit) break
    }
    if (window.end === Infinity) break
    at = window.end
  }
  return out
}
