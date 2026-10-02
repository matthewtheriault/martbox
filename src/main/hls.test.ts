import { describe, expect, it } from 'vitest'
import { segmentCount, vodPlaylist } from './hls'

describe('vodPlaylist', () => {
  it('lists every 4-second segment of the whole file as VOD', () => {
    const text = vodPlaylist(10, (i) => `/seg${i}.ts`)
    expect(text).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(text).toContain('#EXT-X-ENDLIST')
    expect(text).toContain('#EXT-X-TARGETDURATION:5')
    expect(text.match(/#EXTINF:/g)).toHaveLength(3)
    expect(text).toContain('#EXTINF:4.000,\n/seg0.ts')
    expect(text).toContain('#EXTINF:4.000,\n/seg1.ts')
    expect(text).toContain('#EXTINF:2.000,\n/seg2.ts')
  })

  it('handles exact multiples and tiny files', () => {
    expect(vodPlaylist(8, (i) => `s${i}`).match(/#EXTINF:/g)).toHaveLength(2)
    expect(vodPlaylist(0.5, (i) => `s${i}`)).toContain('#EXTINF:0.500,\ns0')
  })

  it('sums to the real duration', () => {
    const total = [...vodPlaylist(5423.7, (i) => `s${i}`).matchAll(/#EXTINF:([\d.]+),/g)]
      .map((m) => Number(m[1]))
      .reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(5423.7, 2)
  })
})

describe('segmentCount', () => {
  it('folds a leftover under a second into the last segment', () => {
    expect(segmentCount(60.012)).toBe(15)
    expect(segmentCount(60.9)).toBe(15)
    expect(segmentCount(61)).toBe(15)
    expect(segmentCount(61.5)).toBe(16)
    expect(segmentCount(62)).toBe(16)
    expect(segmentCount(4)).toBe(1)
    expect(segmentCount(0.4)).toBe(1)
  })

  it('never lists a segment longer than the target duration', () => {
    for (const d of [60.012, 60.99, 5423.7, 4.9, 3]) {
      const lengths = [...vodPlaylist(d, (i) => `s${i}`).matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]))
      expect(Math.max(...lengths)).toBeLessThanOrEqual(5)
      expect(lengths.reduce((a, b) => a + b, 0)).toBeCloseTo(d, 2)
    }
  })
})
