import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { fingerprint, identifyingFile } from './gameFingerprint'

const dir = mkdtempSync(join(tmpdir(), 'martbox-fp-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('game fingerprints', () => {
  it('follow the contents, not the name', () => {
    const data = Buffer.alloc(3 * 1024 * 1024, 7)
    writeFileSync(join(dir, 'Pocket Hero (USA).gba'), data)
    writeFileSync(join(dir, 'pocket hero renamed.gba'), data)
    const other = Buffer.from(data)
    other[other.length - 1] = 8
    writeFileSync(join(dir, 'Other.gba'), other)
    const a = fingerprint(join(dir, 'Pocket Hero (USA).gba'))
    expect(a).toMatch(/^[0-9a-f]{40}$/)
    expect(fingerprint(join(dir, 'pocket hero renamed.gba'))).toBe(a)
    // A change at the end of the file is seen too.
    expect(fingerprint(join(dir, 'Other.gba'))).not.toBe(a)
  })

  it('handles small files and missing ones', () => {
    writeFileSync(join(dir, 'tiny.gb'), Buffer.from([1, 2, 3]))
    expect(fingerprint(join(dir, 'tiny.gb'))).toMatch(/^[0-9a-f]{40}$/)
    expect(fingerprint(join(dir, 'gone.gb'))).toBeNull()
  })

  it('identifies disc games by their data, not their cue sheet', () => {
    const at = (p: string): string => join('/games/Disc', p)
    expect(identifyingFile('/games/Disc/Disc.cue', ['Disc (Track 1).bin', 'Disc (Track 2).bin'], at)).toBe(at('Disc (Track 1).bin'))
    expect(identifyingFile('/games/Disc/Disc.m3u', ['Disc 1.cue', 'Disc 1 (Track 1).bin'], at)).toBe(at('Disc 1 (Track 1).bin'))
    expect(identifyingFile('/games/Hero.gba', [], at)).toBe('/games/Hero.gba')
  })
})
