// What Continue Watching shows: each movie someone is part-way through, and
// one entry per show — the episode they were last in, or, when they last
// finished one, the show's next episode. Pure, so it's tested without a
// database (continueWatchingCore.test.ts).

export interface ProgressRow {
  mediaType: 'movie' | 'episode'
  mediaId: number
  positionSeconds: number
  durationSeconds: number
  watched: boolean
  updatedAt: string
  // Episodes only.
  showId: number | null
}

export interface NextEpisode {
  id: number
  durationSeconds: number | null
  // Its own progress, if started.
  positionSeconds: number
}

export interface ContinuePick {
  mediaType: 'movie' | 'episode'
  mediaId: number
  positionSeconds: number
  durationSeconds: number
  updatedAt: string
}

// `rows`: the profile's movie and episode progress, newest first.
// `nextAfter(episodeId)`: the first episode after it, in order, not yet
// watched; null when the show is finished.
export function pickContinueWatching(rows: ProgressRow[], nextAfter: (episodeId: number) => NextEpisode | null, limit: number): ContinuePick[] {
  const picks: ContinuePick[] = []
  const shows = new Set<number>()
  for (const r of rows) {
    if (picks.length >= limit) break
    if (r.mediaType === 'movie') {
      if (!r.watched && r.positionSeconds > 0) {
        picks.push({ mediaType: 'movie', mediaId: r.mediaId, positionSeconds: r.positionSeconds, durationSeconds: r.durationSeconds, updatedAt: r.updatedAt })
      }
      continue
    }
    // Only a show's most recent episode counts.
    if (r.showId === null || shows.has(r.showId)) continue
    shows.add(r.showId)
    if (!r.watched) {
      if (r.positionSeconds > 0) {
        picks.push({ mediaType: 'episode', mediaId: r.mediaId, positionSeconds: r.positionSeconds, durationSeconds: r.durationSeconds, updatedAt: r.updatedAt })
      }
      continue
    }
    const next = nextAfter(r.mediaId)
    if (next) {
      picks.push({
        mediaType: 'episode',
        mediaId: next.id,
        positionSeconds: next.positionSeconds,
        durationSeconds: next.durationSeconds ?? 0,
        updatedAt: r.updatedAt
      })
    }
  }
  return picks
}
