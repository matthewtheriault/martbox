import { describe, it, expect, vi } from 'vitest'

// scanner.ts pulls in repository.ts -> db.ts, which touches Electron's
// `app` module at import time. Mocked here so these pure-parsing tests can
// run under plain Node/vitest without an Electron process.
vi.mock('./repository', () => ({
  registerMovieFile: vi.fn(),
  upsertShow: vi.fn(),
  registerEpisodeFile: vi.fn(),
  deleteShowByFolderPath: vi.fn(),
  findShowByTitle: vi.fn(),
  pruneMissingMovies: vi.fn(),
  pruneMissingEpisodes: vi.fn()
}))

const { parseMovieName, parseEpisodeName, parseShowFolderName } = await import('./scanner')

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
