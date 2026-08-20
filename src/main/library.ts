import type { ScanProgress } from '../shared/types'
import {
  getLibrary,
  listEpisodes,
  upsertEpisode,
  upsertMovie,
  upsertShow,
  findShowByTmdbId,
  mergeShows
} from './repository'
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
      // Already matched (automatically or by hand via Edit Metadata) — a
      // rescan's job is finding new files, not re-deciding old ones. Without
      // this, every rescan re-ran the search and overwrote whatever was
      // already there, silently undoing manual corrections. titleLocked
      // covers a manual edit made *without* ever picking a tmdb match (so
      // tmdbId alone wouldn't catch it).
      if (movie.tmdbId || movie.titleLocked) continue
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
          runtimeMinutes: match?.runtimeMinutes ?? (probe.durationSeconds ? Math.round(probe.durationSeconds / 60) : null),
          genres: match?.genres ?? movie.genres,
          collectionId: match?.collectionId ?? movie.collectionId,
          collectionName: match?.collectionName ?? movie.collectionName,
          collectionPosterPath: match?.collectionPosterPath ?? movie.collectionPosterPath,
          cast: match?.cast ?? movie.cast,
          crew: match?.crew ?? movie.crew,
          trailerKey: match?.trailerKey ?? movie.trailerKey
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
        // Already matched — a rescan's job is finding new episodes, not
        // re-deciding the show itself. Without this, every rescan re-ran the
        // search and overwrote whatever was already there (including a
        // manually-picked match), and re-merged on every pass for no reason.
        // titleLocked covers a manual edit made *without* ever picking a
        // tmdb match (so tmdbId alone wouldn't catch it).
        let updatedShow = show
        if (!show.tmdbId && !show.titleLocked) {
          const match = await matchShow(show.title, show.year)
          updatedShow = upsertShow({
            ...show,
            tmdbId: match?.tmdbId ?? show.tmdbId,
            overview: match?.overview ?? show.overview,
            posterPath: match?.posterPath ?? show.posterPath,
            backdropPath: match?.backdropPath ?? show.backdropPath,
            rating: match?.rating ?? show.rating,
            year: match?.year ?? show.year,
            genres: match?.genres ?? show.genres,
            cast: match?.cast ?? show.cast,
            crew: match?.crew ?? show.crew,
            trailerKey: match?.trailerKey ?? show.trailerKey
          })

          // Different releases of the same show sometimes parse to different
          // title strings (a subtitle present in one folder's name but not
          // another's) and so never merge as duplicates — but if they both
          // matched the same TMDb entry, that shared tmdbId is proof they're
          // the same show. Fold this one into whichever show claimed that
          // tmdbId first.
          if (updatedShow.tmdbId) {
            const canonical = findShowByTmdbId(updatedShow.tmdbId)
            if (canonical && canonical.id !== updatedShow.id) {
              updatedShow = mergeShows(canonical.id, [updatedShow.id])
            }
          }
        }

        // overview is the "already matched" signal at the episode level (see
        // registerEpisodeFile) — only unmatched episodes (new files, e.g. a
        // freshly-added season on an already-matched show) need fetching.
        const unmatchedEpisodes = listEpisodes(updatedShow.id).filter((e) => !e.overview)
        const seasons = [...new Set(unmatchedEpisodes.map((e) => e.seasonNumber))]

        for (const season of seasons) {
          const seasonEpisodes =
            updatedShow.tmdbId ? await matchSeasonEpisodes(updatedShow.tmdbId, season) : []
          for (const ep of unmatchedEpisodes.filter((e) => e.seasonNumber === season)) {
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
