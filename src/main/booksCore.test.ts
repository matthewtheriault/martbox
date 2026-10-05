import { describe, expect, it } from 'vitest'
import { comicInfoMeta, comicNameMeta, comicPages, epubMeta, formatOf, opfPath } from './booksCore'

describe('formats', () => {
  it('knows books from comics', () => {
    expect(formatOf('/b/x.epub')).toBe('epub')
    expect(formatOf('/b/x.PDF')).toBe('pdf')
    expect(['/b/a.cbz', '/b/b.cbr', '/b/c.cb7'].map(formatOf)).toEqual(['comic', 'comic', 'comic'])
    expect(formatOf('/b/notes.txt')).toBeNull()
  })
})

describe('comic pages', () => {
  it('orders images naturally and skips everything else', () => {
    expect(comicPages(['p10.jpg', 'ComicInfo.xml', 'p2.jpg', 'p1.png', '__MACOSX/._p1.png', '.DS_Store', 'extra/p3.jpg'])).toEqual([
      'extra/p3.jpg',
      'p1.png',
      'p2.jpg',
      'p10.jpg'
    ])
  })
})

describe('comic details', () => {
  it('reads series and number from the file name', () => {
    expect(comicNameMeta('/c/Saga 012 (2013) (Digital).cbz')).toMatchObject({ series: 'Saga', seriesIndex: '12', year: 2013, title: 'Saga 12' })
    expect(comicNameMeta('/c/Saga #3.cbr')).toMatchObject({ series: 'Saga', seriesIndex: '3' })
    expect(comicNameMeta('/c/One Shot.cbz')).toMatchObject({ title: 'One Shot', series: null })
  })

  it('prefers ComicInfo.xml', () => {
    const xml = '<?xml version="1.0"?><ComicInfo><Series>Test Hero</Series><Number>1</Number><Title>Origins</Title><Writer>Ann Author</Writer><Year>2021</Year><Summary>Our hero begins.</Summary></ComicInfo>'
    expect(comicInfoMeta(xml, '/c/whatever.cbz')).toEqual({
      title: 'Origins',
      author: 'Ann Author',
      series: 'Test Hero',
      seriesIndex: '1',
      year: 2021,
      description: 'Our hero begins.'
    })
  })
})

describe('EPUB details', () => {
  it('finds the package file', () => {
    expect(opfPath('<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')).toBe('OEBPS/content.opf')
  })

  it('reads EPUB 2 metadata and the cover', () => {
    const opf = `<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title>The Test</dc:title><dc:creator>Ed Writer</dc:creator><dc:date>2019-05-01</dc:date>
      <dc:description>&lt;p&gt;A tale.&lt;/p&gt;</dc:description>
      <meta name="cover" content="img1"/><meta name="calibre:series" content="Tests"/><meta name="calibre:series_index" content="2.0"/>
      </metadata><manifest><item id="img1" href="images/My%20Cover.jpg" media-type="image/jpeg"/></manifest></package>`
    expect(epubMeta(opf, 'OEBPS/content.opf', '/b/x.epub')).toEqual({
      title: 'The Test',
      author: 'Ed Writer',
      series: 'Tests',
      seriesIndex: '2',
      year: 2019,
      description: 'A tale.',
      coverPath: 'OEBPS/images/My Cover.jpg'
    })
  })

  it('reads EPUB 3 covers and collections', () => {
    const opf = `<package><metadata><dc:title>Three</dc:title>
      <meta property="belongs-to-collection" id="c1">Saga Books</meta><meta refines="#c1" property="group-position">4</meta>
      </metadata><manifest><item id="x" href="cover.png" media-type="image/png" properties="cover-image"/></manifest></package>`
    expect(epubMeta(opf, 'content.opf', '/b/three.epub')).toMatchObject({ title: 'Three', series: 'Saga Books', seriesIndex: '4', coverPath: 'cover.png' })
  })
})
