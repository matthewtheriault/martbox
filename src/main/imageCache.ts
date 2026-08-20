import { readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { db } from './db'
import { logError } from './errorLog'

// Cached poster/backdrop/still images are never deleted when a movie/show/
// episode is removed, re-matched (which points it at a newly-cached file,
// orphaning the old one), or merged — cacheImage() in tmdb.ts only ever
// adds files, nothing ever removes them. Left unchecked this grows forever
// (337MB / 11k files observed on one real install). This reconciles the
// cache directory against every path the DB currently references and
// deletes whatever's left over.
export function sweepOrphanedImages(imageCacheDir: string): void {
  try {
    const referenced = new Set<string>()
    const collect = (rows: Array<Record<string, unknown>>, ...cols: string[]): void => {
      for (const row of rows) {
        for (const col of cols) {
          const value = row[col]
          if (typeof value === 'string' && value) referenced.add(value)
        }
      }
    }
    collect(
      db
        .prepare('SELECT poster_path, backdrop_path, collection_poster_path FROM movies')
        .all() as Array<Record<string, unknown>>,
      'poster_path',
      'backdrop_path',
      'collection_poster_path'
    )
    collect(
      db.prepare('SELECT poster_path, backdrop_path FROM shows').all() as Array<
        Record<string, unknown>
      >,
      'poster_path',
      'backdrop_path'
    )
    collect(
      db.prepare('SELECT still_path FROM episodes').all() as Array<Record<string, unknown>>,
      'still_path'
    )

    let files: string[]
    try {
      files = readdirSync(imageCacheDir)
    } catch {
      return
    }

    for (const file of files) {
      const fullPath = join(imageCacheDir, file)
      if (referenced.has(fullPath)) continue
      try {
        unlinkSync(fullPath)
      } catch {
        /* skip files we can't remove (in use, permissions, etc.) */
      }
    }
  } catch (err) {
    logError('imageCacheSweep', err)
  }
}
