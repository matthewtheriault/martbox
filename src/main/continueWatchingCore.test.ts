import { describe, expect, it } from 'vitest'
import { pickContinueWatching, type NextEpisode, type ProgressRow } from './continueWatchingCore'

const ep = (id: number, showId: number, at: string, positionSeconds: number, watched = false): ProgressRow => ({
  mediaType: 'episode',
  mediaId: id,
  positionSeconds,
  durationSeconds: 1500,
  watched,
  updatedAt: at,
  showId
})
const movie = (id: number, at: string, positionSeconds: number, watched = false): ProgressRow => ({
  mediaType: 'movie',
  mediaId: id,
  positionSeconds,
  durationSeconds: 6000,
  watched,
  updatedAt: at,
  showId: null
})

// Show 1: episodes 11–15; show 2: episodes 21–22.
const order: Record<number, number[]> = { 1: [11, 12, 13, 14, 15], 2: [21, 22] }
const showOf = (id: number): number => (id < 20 ? 1 : 2)
const nextAfter =
  (watched: Set<number>, started: Record<number, number> = {}) =>
  (id: number): NextEpisode | null => {
    const list = order[showOf(id)]
    const next = list.slice(list.indexOf(id) + 1).find((e) => !watched.has(e))
    return next ? { id: next, durationSeconds: 1400, positionSeconds: started[next] ?? 0 } : null
  }

describe('Continue Watching', () => {
  it('shows each show once, at its most recent episode', () => {
    const rows = [ep(15, 1, '5', 300), ep(14, 1, '4', 600), ep(12, 2 - 1, '3', 100), movie(7, '2', 900)]
    expect(pickContinueWatching(rows, nextAfter(new Set()), 20).map((p) => p.mediaId)).toEqual([15, 7])
  })

  it('offers the next episode after a finished one, from the start', () => {
    const rows = [ep(13, 1, '5', 1500, true), ep(14, 1, '4', 200)]
    const picks = pickContinueWatching(rows, nextAfter(new Set([11, 12, 13])), 20)
    expect(picks).toEqual([{ mediaType: 'episode', mediaId: 14, positionSeconds: 0, durationSeconds: 1400, updatedAt: '5' }])
  })

  it('keeps a started next episode where it was', () => {
    const picks = pickContinueWatching([ep(13, 1, '5', 1500, true)], nextAfter(new Set([13]), { 14: 320 }), 20)
    expect(picks[0]).toMatchObject({ mediaId: 14, positionSeconds: 320 })
  })

  it('drops a finished show and finished movies', () => {
    const rows = [ep(22, 2, '6', 1500, true), movie(8, '5', 6000, true), ep(21, 2, '4', 200)]
    expect(pickContinueWatching(rows, nextAfter(new Set([21, 22])), 20)).toEqual([])
  })

  it('keeps the order of what was watched last, and the limit', () => {
    const rows = [movie(7, '9', 100), ep(21, 2, '8', 50), ep(12, 1, '7', 40), movie(8, '6', 30)]
    expect(pickContinueWatching(rows, nextAfter(new Set()), 3).map((p) => p.mediaId)).toEqual([7, 21, 12])
  })
})
