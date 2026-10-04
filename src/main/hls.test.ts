import { describe, expect, it } from 'vitest'
import {
  remuxPlaylist,
  remuxSegmentStarts,
  segmentCount,
  variantFromQuery,
  variantKey,
  vodPlaylist
} from './hls'

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

describe('remuxSegmentStarts', () => {
  const keyframes = [0, 2.711, 3.128, 9.927, 10.427, 17.226, 23.023, 23.524, 31.823, 38.038, 44.419, 50.133, 51.009, 57.307]

  it('starts a segment at the first keyframe at least 6 s after the last', () => {
    expect(remuxSegmentStarts(keyframes, 60.06)).toEqual([0, 9.927, 17.226, 23.524, 31.823, 38.038, 44.419, 51.009, 57.307])
  })

  it("doesn't start a segment in the last second", () => {
    expect(remuxSegmentStarts(keyframes, 57.9)).toEqual([0, 9.927, 17.226, 23.524, 31.823, 38.038, 44.419, 51.009])
  })

  it('keeps a first keyframe a few ms in', () => {
    expect(remuxSegmentStarts([0.005, 7, 14], 20)).toEqual([0.005, 7, 14])
  })
})

describe('remuxPlaylist', () => {
  it('is a fragmented-MP4 VOD playlist whose lengths add up to the duration', () => {
    const text = remuxPlaylist([0.005, 7, 14], 20.5, '/init.mp4', (i) => `/s${i}.m4s`)
    expect(text).toContain('#EXT-X-VERSION:7')
    expect(text).toContain('#EXT-X-MAP:URI="/init.mp4"')
    expect(text).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(text).toContain('#EXT-X-TARGETDURATION:7')
    expect(text).toContain('#EXTINF:7.000,\n/s0.m4s')
    expect(text).toContain('#EXTINF:6.500,\n/s2.m4s')
    const total = [...text.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(20.5, 3)
  })
})

describe('variantFromQuery', () => {
  it('reads remux and transcode requests, defaulting to a 1080p transcode', () => {
    expect(variantFromQuery({ mode: 'remux' })).toEqual({ kind: 'remux', audio: 'copy' })
    expect(variantFromQuery({ mode: 'remux', audio: 'convert' })).toEqual({ kind: 'remux', audio: 'convert' })
    expect(variantFromQuery({ h: '720', audio: 'copy' })).toEqual({ kind: 'transcode', rung: { height: 720, kbps: 4000 }, audio: 'copy' })
    expect(variantFromQuery({})).toEqual({ kind: 'transcode', rung: { height: 1080, kbps: 8000 }, audio: 'stereo' })
    expect(variantFromQuery({ h: '9999' })).toEqual({ kind: 'transcode', rung: { height: 1080, kbps: 8000 }, audio: 'stereo' })
    expect(variantKey(variantFromQuery({ h: '480', audio: 'convert' }))).toBe('transcode:480:1500:convert')
  })
})
