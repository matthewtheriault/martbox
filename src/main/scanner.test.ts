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

// Every case here reproduces a naming pattern that once broke the scanner
// (titles and group tags are made up) — keep this list growing instead of
// trimming it, so a future change can't silently re-break a fix that was
// already paid for once.
describe('parseShowFolderName', () => {
  const cases: Array<[string, string]> = [
    ['Harbor.and.Finch.S01E02.Sand.Racer.480p.WEB-DL.AAC2.0.H.264-GRP', 'Harbor and Finch'],
    [
      'Crown.of.Ashes.SEASON.01.S01.COMPLETE.1080p.10bit.BluRay.6CH.x265.HEVC-GRP',
      'Crown of Ashes'
    ],
    ['The.Ledge.S01E01.1080p.WEB.H264-GRP', 'The Ledge'],
    [
      'Quiet.Chemistry.SEASON.01.S01.COMPLETE.1080p.10bit.BluRay.6CH.x265.HEVC-GRP',
      'Quiet Chemistry'
    ],
    ['Ring Night Clash', 'Ring Night Clash'],
    ['Ring Night', 'Ring Night'],
    ['Otto - Season 1 (2024)', 'Otto'],
    [
      'www.example.org    -    The.Lanterns.S05E03.REPACK.1080p.HEVC.x265-GRP',
      'The Lanterns'
    ],
    [
      'www.example.org    -    Coach.Miller.S04E02.REPACK.1080p.WEB.H264-GRP',
      'Coach Miller'
    ],
    [
      'www.example.org    -    House.of.the.Heron.S03E06.Grey.Tide.REPACK.1080p.HEVC.x265-GRP',
      'House of the Heron'
    ],
    [
      'www.example.org    -    A.Club.of.Their.Own.UK.S16E08.1080p.AV1.10bit-GRP',
      'A Club of Their Own UK'
    ],
    [
      '[Sub Group] Star Blade Z Complete Series (Colour Corrected) [DVD] [Dual Audio] [480p][HEVC 10bit x265][AAC,AC3][Eng Sub] [Batch]',
      'Star Blade Z Complete Series (Colour Corrected) [DVD]'
    ],
    ['House of Tiles Season 3 Complete 1920 x 960 x264 Some Group', 'House of Tiles'],
    ['Pip &amp; Mabel Season 8 (1998)', 'Pip & Mabel']
  ]

  for (const [input, expectedTitle] of cases) {
    it(`parses "${input}" -> "${expectedTitle}"`, () => {
      expect(parseShowFolderName(input).title).toBe(expectedTitle)
    })
  }

  it('does not read a resolution like "1920 x 960" as a year', () => {
    expect(
      parseShowFolderName('House of Tiles Season 3 Complete 1920 x 960 x264 Some Group').year
    ).toBeNull()
  })

  it('does read a real year even next to a season marker', () => {
    expect(parseShowFolderName('Otto - Season 1 (2024)').year).toBe(2024)
  })
})

describe('parseEpisodeName', () => {
  it('parses the tight S01E02 form', () => {
    const p = parseEpisodeName('Harbor.and.Finch.S01E02.Sand.Racer.480p.WEB-DL.AAC2.0.H.264-GRP')
    expect(p).toMatchObject({ season: 1, episode: 2 })
  })

  it('parses a space between season and episode markers', () => {
    const p = parseEpisodeName(
      'Night Owl T.A.S - S02 E01 - Shadow of The Owl, Part 1 (1080p - BluRay)'
    )
    expect(p).toMatchObject({ season: 2, episode: 1 })
  })

  it('parses "S01 - E01" with dashes around the separator', () => {
    const p = parseEpisodeName("Mrs. Green's Lads - S01 - E01 - The Kettle")
    expect(p).toMatchObject({ season: 1, episode: 1 })
  })

  it('parses fully spelled-out "Season 01 Episode 01"', () => {
    const p = parseEpisodeName(
      "Keeping Up Pretenses Season 01 Episode 01 - Uncle's Mishap 720p WEB-DL H264 GRP"
    )
    expect(p).toMatchObject({ season: 1, episode: 1 })
  })

  it('falls back to a bare leading number with no S/E marker', () => {
    const p = parseEpisodeName(
      '01_Comet_Waltz_720p_En_Jp_DualAudio_En_Sub_Space_Drifter'
    )
    expect(p).toMatchObject({ season: 1, episode: 1, episodeTitle: 'Comet Waltz' })
  })

  it('falls back to a bare "title - NNN - title" number', () => {
    const p = parseEpisodeName('Star Blade Z - 001 - The New Rival')
    expect(p).toMatchObject({ season: 1, episode: 1 })
  })

  it('does not mistake "x264"/"720p" for a bare episode number', () => {
    // Regression guard: BARE_NUMBER requires a real delimiter on both sides,
    // so quality tags glued to a letter (no delimiter) must never match.
    const p = parseEpisodeName('SomeShow.WEB.h264-GROUP')
    expect(p).toBeNull()
  })

  it('parses YYYY MM DD dated episodes (season = year, episode = MMDD)', () => {
    const p = parseEpisodeName('Ring Night 2019 10 02')
    expect(p).toMatchObject({ season: 2019, episode: 1002 })
  })

  it('parses DD-MM-YY dated episodes', () => {
    const p = parseEpisodeName('Ring Night Steel Cage 29-06-22')
    expect(p).toMatchObject({ season: 2022, episode: 629 })
  })

  it('parses "Month Dth YYYY" dated episodes', () => {
    const p = parseEpisodeName('Ring Night Clash January 4th 2024')
    expect(p).toMatchObject({ season: 2024, episode: 104 })
  })

  it('prefers a date over a coincidental embedded episode number', () => {
    const p = parseEpisodeName('Ring Night on Stream Episode 124 16-02-22')
    expect(p).toMatchObject({ season: 2022, episode: 216 })
  })

  it('returns null for a filename with no date and no S/E marker at all', () => {
    expect(parseEpisodeName('Ring Night Pilot')).toBeNull()
  })
})

describe('parseMovieName', () => {
  it('strips a site watermark before parsing', () => {
    const p = parseMovieName(
      'www.example.org    -    The Vigilante One Last Job 2026 1080p WEB-DL DDP5 1 Atmos H 264-GRP'
    )
    expect(p).toMatchObject({ title: 'The Vigilante One Last Job', year: 2026 })
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
  const coachMillerDir = join(libPath, 'Coach Miller')
  const looseFile = join(libPath, 'coach.miller.s04e03.1080p.web.h264-grp[example.site].mkv')
  const existingEpisode = join(coachMillerDir, 'Coach.Miller.S04E01.1080p.WEB.H264-GRP.mkv')

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
      dirEntry('Coach Miller'),
      fileEntry('coach.miller.s04e03.1080p.web.h264-grp[example.site].mkv')
    ]
    tree[coachMillerDir] = [fileEntry('Coach.Miller.S04E01.1080p.WEB.H264-GRP.mkv')]

    scanTvLibrary(library)

    // One show, not two — the loose file's parsed title ("Coach Miller") must
    // fold into the same group as the existing "Coach Miller" folder rather
    // than spawning a duplicate.
    expect(repository.upsertShow).toHaveBeenCalledTimes(1)
    expect(repository.upsertShow).toHaveBeenCalledWith(
      expect.objectContaining({ folderPath: coachMillerDir, title: 'Coach Miller' })
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
      dirEntry('Coach Miller'),
      fileEntry('The.Galley.S03E01.1080p.WEB.H264-GRP.mkv')
    ]
    tree[coachMillerDir] = [fileEntry('Coach.Miller.S04E01.1080p.WEB.H264-GRP.mkv')]

    scanTvLibrary(library)

    expect(repository.upsertShow).toHaveBeenCalledTimes(2)
    expect(repository.upsertShow).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'The Galley', folderPath: join(libPath, 'The Galley') })
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
      dirEntry('Coach Miller'),
      fileEntry('The.Galley.S03E01.1080p.WEB.H264-GRP.mkv')
    ]
    tree[coachMillerDir] = [fileEntry('Coach.Miller.S04E01.1080p.WEB.H264-GRP.mkv')]

    const theGalleySyntheticPath = join(libPath, 'The Galley')
    const existingShow = {
      id: 99,
      libraryId: 1,
      folderPath: theGalleySyntheticPath,
      title: 'The Galley',
      sortTitle: 'galley',
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
      paths.includes(theGalleySyntheticPath) ? existingShow : null
    )

    scanTvLibrary(library)

    // Coach Miller is still brand new and must still be created — only The
    // Galley's already-known synthetic path should be reused.
    expect(repository.upsertShow).toHaveBeenCalledTimes(1)
    expect(repository.upsertShow).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Coach Miller' })
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
      dirEntry('Coach Miller'),
      fileEntry('coach.miller.s04e03.1080p.web.h264-grp[example.site].mkv')
    ]
    tree[coachMillerDir] = [fileEntry('Coach.Miller.S04E01.1080p.WEB.H264-GRP.mkv')]

    const existingShow = {
      id: 42,
      libraryId: 1,
      folderPath: coachMillerDir,
      title: 'Coach Miller (Manually Renamed)',
      sortTitle: 'coach miller (manually renamed)',
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
      fileEntry('Space.Drifter.S01E01.mkv'),
      fileEntry('Space.Drifter.S01E02.mkv')
    ]

    scanTvLibrary(library)

    expect(repository.upsertShow).toHaveBeenCalledTimes(1)
    expect(repository.upsertShow).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Space Drifter' })
    )
    expect(repository.registerEpisodeFile).toHaveBeenCalledTimes(2)
  })

  it('does not delete a real show folder just because a same-titled loose file also merged into its group', () => {
    tree[libPath] = [
      dirEntry('Coach Miller'),
      fileEntry('coach.miller.s04e03.1080p.web.h264-grp[example.site].mkv')
    ]
    tree[coachMillerDir] = [fileEntry('Coach.Miller.S04E01.1080p.WEB.H264-GRP.mkv')]

    scanTvLibrary(library)

    expect(repository.foldShowFolderPath).not.toHaveBeenCalled()
  })
})
