import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'

// scanner.ts pulls in repository.ts -> db.ts, which touches Electron's
// `app` module at import time. Mocked here so these pure-parsing tests can
// run under plain Node/vitest without an Electron process.
vi.mock('./repository', () => ({
  registerMovieFile: vi.fn(),
  upsertShow: vi.fn(),
  registerEpisodeFile: vi.fn(),
  foldShowFolderPath: vi.fn(),
  findShowByTitle: vi.fn(),
  findShowByFolderPathAny: vi.fn(),
  pruneMissingMovies: vi.fn(),
  pruneMissingEpisodes: vi.fn()
}))

// Stands in for the real disk so scanTvLibrary's directory-walking logic
// (listSubdirectories / listTopLevelVideoFiles / walk) can be driven purely
// from an in-memory map of dir path -> Dirent-like entries.
vi.mock('fs', () => ({
  readdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
  statSync: vi.fn()
}))

const { parseMovieName, parseEpisodeName, parseShowFolderName, scanTvLibrary } =
  await import('./scanner')
const repository = await import('./repository')
const fs = await import('fs')

// Every case here is a real folder/file name pulled from the user's actual
// library while tracking down scanner bugs — keep this list growing instead
// of trimming it, so a future change can't silently re-break a fix that was
// already paid for once.
describe('parseShowFolderName', () => {
  const cases: Array<[string, string]> = [
    ['Drake.and.Josh.S01E02.Dune.Buggy.480p.WEB-DL.AAC2.0.H.264-ATTLLN', 'Drake and Josh'],
    [
      'Game.of.Thrones.SEASON.01.S01.COMPLETE.1080p.10bit.BluRay.6CH.x265.HEVC-PSA',
      'Game of Thrones'
    ],
    ['The.Brink.S01E01.1080p.WEB.H264-DiMEPiECE', 'The Brink'],
    [
      'Breaking.Bad.SEASON.01.S01.COMPLETE.1080p.10bit.BluRay.6CH.x265.HEVC-PSA',
      'Breaking Bad'
    ],
    ['AEW Collision', 'AEW Collision'],
    ['AEW Dynamite', 'AEW Dynamite'],
    ['Ted - Season 1 (2024)', 'Ted'],
    [
      'www.UIndex.org    -    The.Boys.S05E03.REPACK.1080p.HEVC.x265-MeGusta',
      'The Boys'
    ],
    [
      'www.UIndex.org    -    Ted.Lasso.S04E02.REPACK.1080p.WEB.H264-CAKES',
      'Ted Lasso'
    ],
    [
      'www.UIndex.org    -    House.of.the.Dragon.S03E06.Faceless.Man.REPACK.1080p.HEVC.x265-MeGusta',
      'House of the Dragon'
    ],
    [
      'www.UIndex.org    -    A.League.of.Their.Own.UK.S16E08.1080p.AV1.10bit-MeGusta',
      'A League of Their Own UK'
    ],
    [
      '[Anime Time] Dragon Ball Z Complete Series (Colour Corrected) [DVD] [Dual Audio] [480p][HEVC 10bit x265][AAC,AC3][Eng Sub] [Batch]',
      'Dragon Ball Z Complete Series (Colour Corrected) [DVD]'
    ],
    ['House of Cards Season 3 Complete 1920 x 960 x264 Phun Psyz', 'House of Cards'],
    ['Will &amp; Grace Season 8 (1998)', 'Will & Grace']
  ]

  for (const [input, expectedTitle] of cases) {
    it(`parses "${input}" -> "${expectedTitle}"`, () => {
      expect(parseShowFolderName(input).title).toBe(expectedTitle)
    })
  }

  it('does not read a resolution like "1920 x 960" as a year', () => {
    expect(
      parseShowFolderName('House of Cards Season 3 Complete 1920 x 960 x264 Phun Psyz').year
    ).toBeNull()
  })

  it('does read a real year even next to a season marker', () => {
    expect(parseShowFolderName('Ted - Season 1 (2024)').year).toBe(2024)
  })
})

describe('parseEpisodeName', () => {
  it('parses the tight S01E02 form', () => {
    const p = parseEpisodeName('Drake.and.Josh.S01E02.Dune.Buggy.480p.WEB-DL.AAC2.0.H.264-ATTLLN')
    expect(p).toMatchObject({ season: 1, episode: 2 })
  })

  it('parses a space between season and episode markers', () => {
    const p = parseEpisodeName(
      'Batman T.A.S - S02 E01 - Shadow of The Bat, Part 1 (1080p - BluRay)'
    )
    expect(p).toMatchObject({ season: 2, episode: 1 })
  })

  it('parses "S01 - E01" with dashes around the separator', () => {
    const p = parseEpisodeName("Mrs. Brown's Boys - S01 - E01 - The Mammy")
    expect(p).toMatchObject({ season: 1, episode: 1 })
  })

  it('parses fully spelled-out "Season 01 Episode 01"', () => {
    const p = parseEpisodeName(
      "Keeping Up Appearances Season 01 Episode 01 - Daddy's Accident 720p WEB-DL H264 BONE"
    )
    expect(p).toMatchObject({ season: 1, episode: 1 })
  })

  it('falls back to a bare leading number with no S/E marker', () => {
    const p = parseEpisodeName(
      '01_Asteroid_Blues_720p_En_Jp_DualAudio_En_Sub_Cowboy_Bebop'
    )
    expect(p).toMatchObject({ season: 1, episode: 1, episodeTitle: 'Asteroid Blues' })
  })

  it('falls back to a bare "title - NNN - title" number', () => {
    const p = parseEpisodeName('Dragon Ball Z - 001 - The New Threat')
    expect(p).toMatchObject({ season: 1, episode: 1 })
  })

  it('does not mistake "x264"/"720p" for a bare episode number', () => {
    // Regression guard: BARE_NUMBER requires a real delimiter on both sides,
    // so quality tags glued to a letter (no delimiter) must never match.
    const p = parseEpisodeName('SomeShow.WEB.h264-GROUP')
    expect(p).toBeNull()
  })

  it('parses YYYY MM DD dated episodes (season = year, episode = MMDD)', () => {
    const p = parseEpisodeName('AEW Dynamite 2019 10 02')
    expect(p).toMatchObject({ season: 2019, episode: 1002 })
  })

  it('parses DD-MM-YY dated episodes', () => {
    const p = parseEpisodeName('AEW Blood And Guts 29-06-22')
    expect(p).toMatchObject({ season: 2022, episode: 629 })
  })

  it('parses "Month Dth YYYY" dated episodes', () => {
    const p = parseEpisodeName('AEW Collision January 4th 2024')
    expect(p).toMatchObject({ season: 2024, episode: 104 })
  })

  it('prefers a date over a coincidental embedded episode number', () => {
    const p = parseEpisodeName('AEW Dynamite on Fite Episode 124 16-02-22')
    expect(p).toMatchObject({ season: 2022, episode: 216 })
  })

  it('returns null for a filename with no date and no S/E marker at all', () => {
    expect(parseEpisodeName('WWF Smackdown Pilot')).toBeNull()
  })
})

describe('parseMovieName', () => {
  it('strips a site watermark before parsing', () => {
    const p = parseMovieName(
      'www.UIndex.org    -    The Punisher One Last Kill 2026 1080p DSNP WEB-DL DDP5 1 Atmos H 264-FLUX'
    )
    expect(p).toMatchObject({ title: 'The Punisher One Last Kill', year: 2026 })
  })
})

// Fake fs.Dirent factories for driving readdirSync via the in-memory tree
// below, without touching the real filesystem.
function dirEntry(name: string): any {
  return { name, isDirectory: () => true, isFile: () => false }
}
function fileEntry(name: string): any {
  return { name, isDirectory: () => false, isFile: () => true }
}

describe('scanTvLibrary', () => {
  const libPath = 'G:\\TV Shows'
  const tedLassoDir = join(libPath, 'Ted Lasso')
  const looseFile = join(libPath, 'ted.lasso.s04e03.1080p.web.h264-cakes[EZTVx.to].mkv')
  const existingEpisode = join(tedLassoDir, 'Ted.Lasso.S04E01.1080p.WEB.H264-CAKES.mkv')

  const library = { id: 1, path: libPath, type: 'tv', name: 'TV Shows' } as any

  let tree: Record<string, any[]>
  let nextShowId: number

  beforeEach(() => {
    vi.clearAllMocks()
    tree = {}
    nextShowId = 1
    vi.mocked(fs.readdirSync).mockImplementation(((dir: string) => tree[dir] ?? []) as any)
    vi.mocked(repository.findShowByFolderPathAny).mockReturnValue(null)
    vi.mocked(repository.findShowByTitle).mockReturnValue(null)
    vi.mocked(repository.upsertShow).mockImplementation(
      (s: any) => ({ ...s, id: nextShowId++, addedAt: '' }) as any
    )
  })

  it('picks up a loose episode file dropped directly in the library root and merges it into the matching show folder', () => {
    tree[libPath] = [
      dirEntry('Ted Lasso'),
      fileEntry('ted.lasso.s04e03.1080p.web.h264-cakes[EZTVx.to].mkv')
    ]
    tree[tedLassoDir] = [fileEntry('Ted.Lasso.S04E01.1080p.WEB.H264-CAKES.mkv')]

    scanTvLibrary(library)

    // One show, not two — the loose file's parsed title ("Ted Lasso") must
    // fold into the same group as the existing "Ted Lasso" folder rather
    // than spawning a duplicate.
    expect(repository.upsertShow).toHaveBeenCalledTimes(1)
    expect(repository.upsertShow).toHaveBeenCalledWith(
      expect.objectContaining({ folderPath: tedLassoDir, title: 'Ted Lasso' })
    )

    const episodeCalls = vi.mocked(repository.registerEpisodeFile).mock.calls.map((c) => c[0])
    expect(episodeCalls).toContainEqual(
      expect.objectContaining({ seasonNumber: 4, episodeNumber: 1, filePath: existingEpisode })
    )
    expect(episodeCalls).toContainEqual(
      expect.objectContaining({ seasonNumber: 4, episodeNumber: 3, filePath: looseFile })
    )

    // The loose file must also be reported as found so pruneMissingEpisodes
    // doesn't treat it as deleted-from-disk.
    const foundPaths = vi.mocked(repository.pruneMissingEpisodes).mock.calls[0][1]
    expect(foundPaths.has(looseFile)).toBe(true)
  })

  it('gives a loose file with no matching show folder its own synthetic folder path instead of dropping it', () => {
    tree[libPath] = [
      dirEntry('Ted Lasso'),
      fileEntry('The.Bear.S03E01.1080p.WEB.H264-GROUP.mkv')
    ]
    tree[tedLassoDir] = [fileEntry('Ted.Lasso.S04E01.1080p.WEB.H264-CAKES.mkv')]

    scanTvLibrary(library)

    expect(repository.upsertShow).toHaveBeenCalledTimes(2)
    expect(repository.upsertShow).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'The Bear', folderPath: join(libPath, 'The Bear') })
    )
    expect(repository.registerEpisodeFile).toHaveBeenCalledWith(
      expect.objectContaining({ seasonNumber: 3, episodeNumber: 1 })
    )
  })

  // Regression guard: a loose file with no matching folder gets a synthetic
  // representativeDir (see the test above) — once a show already lives at
  // that exact synthetic path (matched, merged, or manually edited on a
  // previous scan), a later scan of the *same still-loose* file must find it
  // by that folder path rather than falling through to upsertShow's
  // ON CONFLICT, which would silently reset tmdb_id/overview back to null
  // and reassign the episode onto the reset row every single rescan.
  it('reuses an existing show at a loose file\'s synthetic folder path instead of upserting over it', () => {
    tree[libPath] = [
      dirEntry('Ted Lasso'),
      fileEntry('The.Bear.S03E01.1080p.WEB.H264-GROUP.mkv')
    ]
    tree[tedLassoDir] = [fileEntry('Ted.Lasso.S04E01.1080p.WEB.H264-CAKES.mkv')]

    const theBearSyntheticPath = join(libPath, 'The Bear')
    const existingShow = {
      id: 99,
      libraryId: 1,
      folderPath: theBearSyntheticPath,
      title: 'The Bear',
      sortTitle: 'bear',
      year: 2022,
      tmdbId: 12345,
      overview: 'matched via TMDb',
      posterPath: null,
      backdropPath: null,
      rating: null,
      genres: [],
      addedAt: '',
      cast: [],
      crew: [],
      trailerKey: null,
      titleLocked: true
    } as any
    vi.mocked(repository.findShowByFolderPathAny).mockImplementation((paths: string[]) =>
      paths.includes(theBearSyntheticPath) ? existingShow : null
    )

    scanTvLibrary(library)

    // Ted Lasso is still brand new and must still be created — only The
    // Bear's already-known synthetic path should be reused.
    expect(repository.upsertShow).toHaveBeenCalledTimes(1)
    expect(repository.upsertShow).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Ted Lasso' })
    )

    const episodeCalls = vi.mocked(repository.registerEpisodeFile).mock.calls.map((c) => c[0])
    expect(episodeCalls).toContainEqual(
      expect.objectContaining({ showId: 99, seasonNumber: 3, episodeNumber: 1 })
    )
  })

  // Regression guard for the "library scans reverting manually-edited
  // titles" fix: once a show already exists at a folder path, a rescan must
  // reuse it via findShowByFolderPathAny rather than calling upsertShow,
  // which would blow away a manual title edit or TMDb match.
  it('reuses an existing show by folder path instead of upserting over it, including for a newly-arrived loose file', () => {
    tree[libPath] = [
      dirEntry('Ted Lasso'),
      fileEntry('ted.lasso.s04e03.1080p.web.h264-cakes[EZTVx.to].mkv')
    ]
    tree[tedLassoDir] = [fileEntry('Ted.Lasso.S04E01.1080p.WEB.H264-CAKES.mkv')]

    const existingShow = {
      id: 42,
      libraryId: 1,
      folderPath: tedLassoDir,
      title: 'Ted Lasso (Manually Renamed)',
      sortTitle: 'ted lasso (manually renamed)',
      year: 2020,
      tmdbId: 999,
      overview: 'edited',
      posterPath: null,
      backdropPath: null,
      rating: null,
      genres: [],
      addedAt: '',
      cast: [],
      crew: [],
      trailerKey: null,
      titleLocked: true
    } as any
    vi.mocked(repository.findShowByFolderPathAny).mockReturnValue(existingShow)

    scanTvLibrary(library)

    expect(repository.upsertShow).not.toHaveBeenCalled()
    const episodeCalls = vi.mocked(repository.registerEpisodeFile).mock.calls.map((c) => c[0])
    expect(episodeCalls.every((c) => c.showId === 42)).toBe(true)
    expect(episodeCalls).toContainEqual(
      expect.objectContaining({ seasonNumber: 4, episodeNumber: 3, filePath: looseFile })
    )
  })

  // Regression guard: a fully flat library (no show subfolders at all) must
  // still fall back to treating every file directly under the root as one
  // single show, keyed off the first file's parsed title.
  it('still treats a library with no show subfolders as one flat show', () => {
    tree[libPath] = [
      fileEntry('Cowboy.Bebop.S01E01.mkv'),
      fileEntry('Cowboy.Bebop.S01E02.mkv')
    ]

    scanTvLibrary(library)

    expect(repository.upsertShow).toHaveBeenCalledTimes(1)
    expect(repository.upsertShow).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Cowboy Bebop' })
    )
    expect(repository.registerEpisodeFile).toHaveBeenCalledTimes(2)
  })

  it('does not delete a real show folder just because a same-titled loose file also merged into its group', () => {
    tree[libPath] = [
      dirEntry('Ted Lasso'),
      fileEntry('ted.lasso.s04e03.1080p.web.h264-cakes[EZTVx.to].mkv')
    ]
    tree[tedLassoDir] = [fileEntry('Ted.Lasso.S04E01.1080p.WEB.H264-CAKES.mkv')]

    scanTvLibrary(library)

    expect(repository.foldShowFolderPath).not.toHaveBeenCalled()
  })
})
