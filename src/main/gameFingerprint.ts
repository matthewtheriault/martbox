import { createHash } from 'crypto'
import { closeSync, openSync, readSync, statSync } from 'fs'
import { extname } from 'path'

// A game's fingerprint: its size plus its first and last megabyte, hashed.
// Enough to know a renamed or moved file is the same game (so its saves
// stay with it), without reading a whole disc image.

const CHUNK = 1024 * 1024

export function fingerprint(file: string): string | null {
  try {
    const size = statSync(file).size
    const fd = openSync(file, 'r')
    try {
      const hash = createHash('sha1').update(String(size))
      const read = (start: number, length: number): void => {
        const buf = Buffer.alloc(length)
        const n = readSync(fd, buf, 0, length, start)
        hash.update(buf.subarray(0, n))
      }
      read(0, Math.min(CHUNK, size))
      if (size > CHUNK) read(Math.max(CHUNK, size - CHUNK), Math.min(CHUNK, size - CHUNK))
      return hash.digest('hex')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

// The file that identifies a game: a disc game's first track or disc
// image, not its cue sheet or playlist (those name the files, so renaming
// changes them).
export function identifyingFile(file: string, parts: string[], resolvePart: (part: string) => string): string {
  const data = parts.find((p) => !['.cue', '.m3u'].includes(extname(p).toLowerCase()))
  return data ? resolvePart(data) : file
}
