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
