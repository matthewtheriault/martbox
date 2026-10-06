import sax from 'sax'
import { basename, extname, posix } from 'path'

// Books and comics (Phase 6), the parts with no I/O: what kind of file a
// book is, a comic's pages in order, and the details inside a comic's
// ComicInfo.xml or an EPUB's package file.

export type BookFormat = 'epub' | 'pdf' | 'comic'

const COMIC_EXTENSIONS = new Set(['.cbz', '.cbr', '.cb7', '.cbt'])
const PAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'])

export function formatOf(file: string): BookFormat | null {
  const ext = extname(file).toLowerCase()
  if (ext === '.epub') return 'epub'
  if (ext === '.pdf') return 'pdf'
  if (COMIC_EXTENSIONS.has(ext)) return 'comic'
  return null
}

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

// A comic's pages: its images in reading order (folders first, then file
// names, numbers compared as numbers), leaving out Mac resource forks.
export function comicPages(entries: string[]): string[] {
  return entries
    .map((e) => e.replace(/\\/g, '/'))
    .filter((e) => PAGE_EXTENSIONS.has(extname(e).toLowerCase()) && !e.split('/').some((p) => p.startsWith('.') || p === '__MACOSX'))
    .sort(naturalCompare)
}

export interface BookMeta {
  title: string
  author: string | null
  series: string | null
  // "1", "2.5": comics and series are numbered.
  seriesIndex: string | null
  year: number | null
  description: string | null
}

// Collects each element's text by its (lower-case) name, keeping the first.
function readXml(xml: string, onOpen?: (name: string, attrs: Record<string, string>) => void): Map<string, string> {
  const parser = sax.parser(false, { lowercase: true })
  const out = new Map<string, string>()
  let text = ''
  parser.onopentag = (node) => {
    text = ''
    onOpen?.(node.name, node.attributes as Record<string, string>)
  }
  parser.ontext = (t) => (text += t)
  parser.oncdata = (t) => (text += t)
  parser.onclosetag = (name) => {
    const v = text.trim()
    if (v && !out.has(name)) out.set(name, v)
    text = ''
  }
  // Real-world EPUBs and ComicInfo files are often not quite valid XML:
  // carry on past the error rather than give up on the whole file.
  parser.onerror = () => {
    ;(parser as unknown as { error: Error | null }).error = null
    parser.resume()
  }
  parser.write(xml).close()
  return out
}

function year(value: string | undefined): number | null {
  const y = parseInt((value ?? '').slice(0, 4), 10)
  return Number.isFinite(y) && y > 1000 ? y : null
}

// "Saga 012 (2013)", "Saga #12", "Saga v02 - Something" → series and number.
export function comicNameMeta(file: string): BookMeta {
  let name = basename(file, extname(file)).replace(/_/g, ' ').trim()
  const y = /\s*\((\d{4})\)/.exec(name)
  const found = y ? parseInt(y[1], 10) : null
  name = name.replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, '').trim()
  const m = /^(.*?)\s*(?:#|v(?:ol\.?)?\s*|issue\s*)?(\d+(?:\.\d+)?)\s*(?:-\s*(.+))?$/i.exec(name)
  if (m && m[1]) {
    return { title: m[3]?.trim() || `${m[1].trim()} ${parseFloat(m[2])}`, author: null, series: m[1].trim(), seriesIndex: String(parseFloat(m[2])), year: found, description: null }
  }
  return { title: name, author: null, series: null, seriesIndex: null, year: found, description: null }
}

export function comicInfoMeta(xml: string, file: string): BookMeta {
  const fromName = comicNameMeta(file)
  const v = readXml(xml)
  const series = v.get('series') ?? fromName.series
  const number = v.get('number') ?? fromName.seriesIndex
  const title = v.get('title') ?? (series && number ? `${series} ${number}` : fromName.title)
  return {
    title,
    author: v.get('writer') ?? v.get('penciller') ?? null,
    series,
    seriesIndex: number,
    year: year(v.get('year')) ?? fromName.year,
    description: v.get('summary') ?? null
  }
}

// META-INF/container.xml → where the EPUB's package (OPF) file is.
export function opfPath(containerXml: string): string | null {
  let path: string | null = null
  readXml(containerXml, (name, attrs) => {
    if (name === 'rootfile' && !path && attrs['full-path']) path = attrs['full-path']
  })
  return path
}

export interface EpubPackage extends BookMeta {
  // The cover image's path inside the EPUB, if it names one.
  coverPath: string | null
}

export function epubMeta(opfXml: string, opfFile: string, file: string): EpubPackage {
  const manifest = new Map<string, { href: string; properties: string; type: string }>()
  let coverId: string | null = null
  let series: string | null = null
  let seriesIndex: string | null = null
  let collectionId: string | null = null
  const values = readXml(opfXml, (name, a) => {
    if (name === 'item' && a.id && a.href) manifest.set(a.id, { href: a.href, properties: a.properties ?? '', type: a['media-type'] ?? '' })
    if (name === 'meta') {
      if (a.name === 'cover' && a.content) coverId = a.content
      if (a.name === 'calibre:series' && a.content) series = a.content
      if (a.name === 'calibre:series_index' && a.content) seriesIndex = String(parseFloat(a.content))
      if (a.property === 'belongs-to-collection' && a.id) collectionId = a.id
    }
  })
  // EPUB 3 collections: <meta property="belongs-to-collection" id="c">Name</meta>
  // with <meta refines="#c" property="group-position">2</meta>.
  if (!series && collectionId) {
    const named = new RegExp(`<meta[^>]*id=["']${collectionId}["'][^>]*>([^<]+)<`, 'i').exec(opfXml)
    const position = new RegExp(`<meta[^>]*refines=["']#${collectionId}["'][^>]*property=["']group-position["'][^>]*>([^<]+)<`, 'i').exec(opfXml)
    if (named) series = named[1].trim()
    if (position) seriesIndex = String(parseFloat(position[1]))
  }
  const cover =
    [...manifest.values()].find((i) => i.properties.split(/\s+/).includes('cover-image')) ??
    (coverId ? manifest.get(coverId) : undefined) ??
    [...manifest.entries()].find(([id, i]) => /cover/i.test(id) && i.type.startsWith('image/'))?.[1]
  const dir = posix.dirname(opfFile.replace(/\\/g, '/'))
  const description = values.get('dc:description') ?? null
  return {
    title: values.get('dc:title') ?? basename(file, extname(file)),
    author: values.get('dc:creator') ?? null,
    series,
    seriesIndex,
    year: year(values.get('dc:date')),
    description: description ? description.replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim() : null,
    coverPath: cover ? posix.normalize(posix.join(dir === '.' ? '' : dir, decodeURIComponent(cover.href))) : null
  }
}

// --- Tidying details that come from the files

// Placeholders some tools write where an author should be.
const NOT_AN_AUTHOR = /^(unknown( author)?|anonymous|author|n\/?a|none|chapter\b.*|part\b.*|contents)$/i

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

// "Golding, William" → "William Golding"; "Weir;" → "Weir"; "CHAPTER ONE" → null.
export function tidyAuthor(author: string | null): string | null {
  if (!author) return null
  let a = author.replace(/\s+/g, ' ').trim().replace(/^[;,:&\s]+|[;,:&\s]+$/g, '')
  if (!a || NOT_AN_AUTHOR.test(a)) return null
  // Several authors in one field: keep them, tidy each.
  const several = a.split(/\s*;\s*|\s+&\s+|\s+and\s+/).filter(Boolean)
  if (several.length > 1) return several.map((one) => tidyAuthor(one)).filter(Boolean).join(' & ') || null
  const flipped = /^([^,\d]+),\s*([^,\d]+)$/.exec(a)
  // Not "Smith, Jr." or "Penguin, Inc.": those commas aren't surname-first.
  if (flipped && !/^(jr|sr|ii|iii|iv|inc|ltd|llc|co|phd|md)\.?$/i.test(flipped[2].trim())) a = `${flipped[2].trim()} ${flipped[1].trim()}`
  return a
}

// A title that is really a file name — "Rowling, J.K - Harry Potter 04 -
// Harry Potter and the Goblet of Fire" — split into author, series, number
// and title.
export function tidyBookMeta(meta: BookMeta): BookMeta {
  let { title, author, series, seriesIndex } = meta
  author = tidyAuthor(author)
  const parts = title.split(/\s+-\s+/)
  if (parts.length >= 2) {
    const first = tidyAuthor(parts[0])
    // The first part names the author: the one we have, or "Last, First" when we have none.
    if (first && ((author && squash(first) === squash(author)) || (!author && /,/.test(parts[0])))) {
      author ??= first
      parts.shift()
    }
    // "Series 04 - Title"
    const numbered = parts.length >= 2 ? /^(.+?)\s+#?(\d+(?:\.\d+)?)$/.exec(parts[0]) : null
    if (numbered) {
      series ??= numbered[1].trim()
      seriesIndex ??= String(parseFloat(numbered[2]))
      parts.shift()
    }
    title = parts.join(' - ')
  }
  return { ...meta, title: title.trim() || meta.title, author, series, seriesIndex }
}
