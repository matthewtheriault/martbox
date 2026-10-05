import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { cueFiles, gameName, m3uFiles, systemOf, thumbnailName } from './gamesCore'

const root = join('/', 'games')
const at = (...parts: string[]): string => join(root, ...parts)

describe('systems', () => {
  it('knows a system from its own extension, wherever the file is', () => {
    expect(systemOf(at('Pocket Hero (USA).gba'), root)).toBe('gba')
    expect(systemOf(at('misc', 'Tiny Tale.GBC'), root)).toBe('gbc')
    expect(systemOf(at('Sky Racer.sfc'), root)).toBe('snes')
    expect(systemOf(at('Sky Racer.z64'), root)).toBe('n64')
    expect(systemOf(at('Two Screens.nds'), root)).toBe('nds')
    expect(systemOf(at('Disc Game', 'Disc Game.cue'), root)).toBe('psx')
    expect(systemOf(at('notes.txt'), root)).toBeNull()
  })

  it('needs a system folder for archives and disc images', () => {
    expect(systemOf(at('SNES', 'Sky Racer.zip'), root)).toBe('snes')
    expect(systemOf(at('Game Boy Advance', 'Pocket Hero.7z'), root)).toBe('gba')
    expect(systemOf(at('PlayStation', 'Disc Game.bin'), root)).toBe('psx')
    expect(systemOf(at('Downloads', 'Sky Racer.zip'), root)).toBeNull()
    // A cartridge folder never holds disc images.
    expect(systemOf(at('NES', 'Sky Racer.bin'), root)).toBeNull()
  })

  it('takes the nearest system folder, and ignores folders above the library', () => {
    expect(systemOf(at('PlayStation', 'Extras', 'Game Boy', 'Tiny Tale.zip'), root)).toBe('gb')
    expect(systemOf(join('/', 'SNES', 'games', 'Sky Racer.zip'), join('/', 'SNES', 'games'))).toBeNull()
  })
})

describe('names', () => {
  it('cleans tags off and keeps the region', () => {
    expect(gameName('Pocket Hero (USA) (Rev 1) [!].gba')).toEqual({ title: 'Pocket Hero', region: 'USA', disc: null })
    expect(gameName('Sky_Racer (Europe, Australia).sfc')).toEqual({ title: 'Sky Racer', region: 'Europe', disc: null })
  })

  it('puts the article back and reads the disc number', () => {
    expect(gameName('Example Quest, The (USA) (Disc 2).cue')).toEqual({ title: 'The Example Quest', region: 'USA', disc: 2 })
    expect(gameName('Legend, A - Second Chapter (Japan).n64').title).toBe('A Legend - Second Chapter')
  })
})

describe('disc games', () => {
  it('lists the tracks a cue sheet uses', () => {
    const cue = 'FILE "Disc Game (Track 1).bin" BINARY\n  TRACK 01 MODE2/2352\nFILE "Disc Game (Track 2).bin" BINARY\n  TRACK 02 AUDIO\n'
    expect(cueFiles(cue)).toEqual(['Disc Game (Track 1).bin', 'Disc Game (Track 2).bin'])
  })

  it('lists the discs in a playlist', () => {
    expect(m3uFiles('#EXTM3U\nDisc Game (Disc 1).cue\n\nDisc Game (Disc 2).cue\r\n')).toEqual(['Disc Game (Disc 1).cue', 'Disc Game (Disc 2).cue'])
  })
})

describe('box art names', () => {
  it('matches the thumbnail collection', () => {
    expect(thumbnailName('Rock & Roll: Racer (USA).sfc')).toBe('Rock _ Roll_ Racer (USA)')
  })
})
