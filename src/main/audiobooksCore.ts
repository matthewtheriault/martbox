import { basename, dirname, extname } from 'path'

// Audiobooks (Phase 5), the parts with no I/O: which files make up a book,
// its title/author/narrator from tags and folder names, and its chapters.

export const AUDIOBOOK_EXTENSIONS = new Set(['.m4b', '.m4a', '.mp3', '.aac', '.ogg', '.opus', '.flac', '.wav'])

// "Part 2" sorts before "Part 10".
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

export interface BookGroup {
  // A stable key: the folder, or the file for a book that is one file among
  // other books in the same folder.
  key: string
  files: string[]
}

// Every folder of audio files is one book (its files in order), except a
// folder of several .m4b files, where each .m4b is a book of its own.
export function groupBooks(files: string[]): BookGroup[] {
  const byFolder = new Map<string, string[]>()
  for (const f of files) {
    const dir = dirname(f)
    byFolder.set(dir, [...(byFolder.get(dir) ?? []), f])
  }
  const books: BookGroup[] = []
  for (const [dir, list] of byFolder) {
    const sorted = [...list].sort((a, b) => naturalCompare(basename(a), basename(b)))
    const m4bs = sorted.filter((f) => extname(f).toLowerCase() === '.m4b')
    if (m4bs.length > 1 && m4bs.length === sorted.length) {
      for (const f of m4bs) books.push({ key: f, files: [f] })
    } else {
      books.push({ key: dir, files: sorted })
    }
  }
  return books.sort((a, b) => naturalCompare(a.key, b.key))
}

export interface ProbedFile {
  path: string
  durationSeconds: number
  codec: string | null
  tags: Record<string, string>
  // Chapters inside the file, in seconds from its start.
  chapters: { title: string; start: number; end: number }[]
}

export interface BookMeta {
  title: string
  author: string
  narrator: string | null
  series: string | null
  year: number | null
  description: string | null
}

export interface Chapter {
  title: string
  start: number
  end: number
}

// ffprobe's tags (format, then the audio stream), keys lower-cased.
export function tagsOf(probe: any): Record<string, string> {
  const out: Record<string, string> = {}
  const add = (tags: Record<string, unknown> | undefined): void => {
    for (const [k, v] of Object.entries(tags ?? {})) {
      const key = k.toLowerCase()
      if (out[key] === undefined && typeof v === 'string' && v.trim()) out[key] = v.trim()
    }
  }
  add(probe?.format?.tags)
  add((probe?.streams ?? []).find((s: any) => s.codec_type === 'audio')?.tags)
  return out
}

export function probedFile(path: string, probe: any): ProbedFile {
  const audio = (probe?.streams ?? []).find((s: any) => s.codec_type === 'audio')
  const duration = parseFloat(probe?.format?.duration ?? audio?.duration ?? '0')
  return {
    path,
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    codec: audio?.codec_name ?? null,
    tags: tagsOf(probe),
    chapters: (probe?.chapters ?? [])
      .map((c: any, i: number) => ({
        title: (c.tags?.title as string | undefined)?.trim() || `Chapter ${i + 1}`,
        start: parseFloat(c.start_time),
        end: parseFloat(c.end_time)
      }))
      .filter((c: Chapter) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
  }
}

// "Author - Title" folder names, and "Title (2019)".
function fromFolder(name: string): { author: string | null; title: string; year: number | null } {
  let title = name.replace(/[_]+/g, ' ').trim()
  let year: number | null = null
  const y = /\s*[([](\d{4})[)\]]\s*$/.exec(title)
  if (y) {
    year = parseInt(y[1], 10)
    title = title.slice(0, y.index).trim()
  }
  const dash = /^(.+?)\s+-\s+(.+)$/.exec(title)
  if (dash) return { author: dash[1].trim(), title: dash[2].trim(), year }
  return { author: null, title, year }
}

export function bookMeta(group: BookGroup, first: ProbedFile): BookMeta {
  const t = first.tags
  const single = group.files.length === 1 && group.key === group.files[0]
  const folderName = single ? basename(group.key, extname(group.key)) : basename(group.key)
  const folder = fromFolder(folderName)
  // Books usually live in Author/Title/ folders.
  const parent = basename(dirname(single ? dirname(group.key) + '/x' : group.key))
  const year = parseInt((t.date ?? t.year ?? '').slice(0, 4), 10)
  return {
    title: t.album || (single && t.title) || folder.title,
    author: t.album_artist || t.artist || folder.author || parent || 'Unknown author',
    narrator: t.narrator || t.composer || t.performer || null,
    series: t.series || t['mvnm'] || t.grouping || null,
    year: Number.isFinite(year) ? year : folder.year,
    description: t.description || t.comment || t.synopsis || null
  }
}

// The book's chapters on one timeline across its files: a file's own
// chapters when it has them, else one chapter per file (named by its title
// tag or file name).
export function bookChapters(files: ProbedFile[]): Chapter[] {
  const out: Chapter[] = []
  let offset = 0
  for (const f of files) {
    if (f.chapters.length > 0) {
      for (const c of f.chapters) out.push({ title: c.title, start: offset + c.start, end: offset + Math.min(c.end, f.durationSeconds || c.end) })
    } else {
      const title = (files.length > 1 && f.tags.title) || basename(f.path, extname(f.path))
      out.push({ title, start: offset, end: offset + f.durationSeconds })
    }
    offset += f.durationSeconds
  }
  return out
}
