import type { ScanProgress } from '../shared/types'
import { getLibrary, listEpisodes, upsertEpisode, upsertMovie, upsertShow } from './repository'
import { scanLibrary as scanFilesystem } from './scanner'
import { matchMovie, matchShow, matchSeasonEpisodes } from './tmdb'
import { probeFile } from './ffprobe'

export async function scanAndMatchLibrary(
  libraryId: number,
  onProgress: (p: ScanProgress) => void
): Promise<void> {
  const library = getLibrary(libraryId)
  if (!library) throw new Error('Library not found')

  onProgress({ libraryId, phase: 'scanning', current: 0, total: 0, message: 'Scanning files…' })
  const { movies, shows } = scanFilesystem(library)

  if (library.type === 'movie') {
    let i = 0
    for (const movie of movies) {
      i++
      onProgress({
        libraryId,
        phase: 'matching',
        current: i,
        total: movies.length,
        message: movie.title
      })
      try {
        const match = await matchMovie(movie.title, movie.year)
        const probe = await probeFile(movie.filePath)
        upsertMovie({
          ...movie,
          tmdbId: match?.tmdbId ?? movie.tmdbId,
          overview: match?.overview ?? movie.overview,
          posterPath: match?.posterPath ?? movie.posterPath,
          backdropPath: match?.backdropPath ?? movie.backdropPath,
          rating: match?.rating ?? movie.rating,
          year: match?.year ?? movie.year,
          runtimeMinutes: match?.runtimeMinutes ?? (probe.durationSeconds ? Math.round(probe.durationSeconds / 60) : null)
        })
      } catch {
        /* keep unmatched entry, continue scanning */
      }
    }
  } else {
    let i = 0
    for (const show of shows) {
      i++
      onProgress({
        libraryId,
        phase: 'matching',
        current: i,
        total: shows.length,
        message: show.title
      })
      try {
        const match = await matchShow(show.title, show.year)
        const updatedShow = upsertShow({
          ...show,
          tmdbId: match?.tmdbId ?? show.tmdbId,
          overview: match?.overview ?? show.overview,
          posterPath: match?.posterPath ?? show.posterPath,
          backdropPath: match?.backdropPath ?? show.backdropPath,
          rating: match?.rating ?? show.rating,
          year: match?.year ?? show.year
        })

        const episodes = listEpisodes(updatedShow.id)
        const seasons = [...new Set(episodes.map((e) => e.seasonNumber))]

        for (const season of seasons) {
          const seasonEpisodes = match ? await matchSeasonEpisodes(match.tmdbId, season) : []
          for (const ep of episodes.filter((e) => e.seasonNumber === season)) {
            const meta = seasonEpisodes.find((m) => m.episodeNumber === ep.episodeNumber)
            const probe = await probeFile(ep.filePath)
            upsertEpisode({
              ...ep,
              title: meta?.title ?? ep.title,
              overview: meta?.overview ?? ep.overview,
              stillPath: meta?.stillPath ?? ep.stillPath,
              airDate: meta?.airDate ?? ep.airDate,
              durationSeconds: probe.durationSeconds ?? ep.durationSeconds
            })
          }
        }
      } catch {
        /* keep unmatched entry, continue scanning */
      }
    }
  }

  onProgress({ libraryId, phase: 'done', current: 1, total: 1, message: 'Done' })
}
