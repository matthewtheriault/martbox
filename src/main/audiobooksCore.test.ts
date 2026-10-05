import { describe, expect, it } from 'vitest'
import { bookChapters, bookMeta, groupBooks, naturalCompare, probedFile } from './audiobooksCore'

const file = (path: string, duration: number, tags: Record<string, string> = {}, chapters: any[] = []): any =>
  probedFile(path, { format: { duration: String(duration), tags }, streams: [{ codec_type: 'audio', codec_name: 'aac' }], chapters })

describe('grouping files into books', () => {
  it('makes a folder of parts one book, in natural order', () => {
    const books = groupBooks(['/b/Author/Book/Part 10.mp3', '/b/Author/Book/Part 2.mp3', '/b/Author/Book/Part 1.mp3'])
    expect(books).toHaveLength(1)
    expect(books[0].files.map((f) => f.split('/').pop())).toEqual(['Part 1.mp3', 'Part 2.mp3', 'Part 10.mp3'])
  })

  it('makes each .m4b in a folder of them its own book', () => {
    const books = groupBooks(['/b/Author/One.m4b', '/b/Author/Two.m4b'])
    expect(books.map((b) => b.key)).toEqual(['/b/Author/One.m4b', '/b/Author/Two.m4b'])
  })

  it('sorts numbers naturally', () => {
    expect(['Track 10', 'Track 9'].sort(naturalCompare)).toEqual(['Track 9', 'Track 10'])
  })
})

describe('book details', () => {
  it('prefers tags', () => {
    const meta = bookMeta({ key: '/b/x', files: ['/b/x/a.m4b'] }, file('/b/x/a.m4b', 10, { album: 'Dune', artist: 'Frank Herbert', composer: 'Scott Brick', date: '1965-08-01' }))
    expect(meta).toMatchObject({ title: 'Dune', author: 'Frank Herbert', narrator: 'Scott Brick', year: 1965 })
  })

  it('falls back to Author/Title folders and "Author - Title (Year)" names', () => {
    const a = bookMeta({ key: '/b/Ursula K. Le Guin/A Wizard of Earthsea', files: ['/b/Ursula K. Le Guin/A Wizard of Earthsea/01.mp3'] }, file('/x/01.mp3', 5))
    expect(a).toMatchObject({ title: 'A Wizard of Earthsea', author: 'Ursula K. Le Guin' })
    const b = bookMeta({ key: '/b/Books/Andy Weir - The Martian (2011)', files: ['/b/Books/Andy Weir - The Martian (2011)/1.mp3'] }, file('/x/1.mp3', 5))
    expect(b).toMatchObject({ title: 'The Martian', author: 'Andy Weir', year: 2011 })
  })

  it('names a single-file book after the file, not its folder', () => {
    const meta = bookMeta({ key: '/b/Author/My Book.m4b', files: ['/b/Author/My Book.m4b'] }, file('/b/Author/My Book.m4b', 5))
    expect(meta.title).toBe('My Book')
    expect(meta.author).toBe('Author')
  })
})

describe('chapters', () => {
  it('uses a file’s own chapters', () => {
    const f = file('/a.m4b', 300, {}, [
      { start_time: '0', end_time: '120', tags: { title: 'Opening' } },
      { start_time: '120', end_time: '300', tags: {} }
    ])
    expect(bookChapters([f])).toEqual([
      { title: 'Opening', start: 0, end: 120 },
      { title: 'Chapter 2', start: 120, end: 300 }
    ])
  })

  it('makes one chapter per file across parts, on one timeline', () => {
    const chapters = bookChapters([file('/b/01 Intro.mp3', 60, { title: 'Intro' }), file('/b/02.mp3', 90)])
    expect(chapters).toEqual([
      { title: 'Intro', start: 0, end: 60 },
      { title: '02', start: 60, end: 150 }
    ])
  })
})
