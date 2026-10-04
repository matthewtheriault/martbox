import { describe, expect, it } from 'vitest'
import type { MediaProbe } from './ffprobe'
import { decidePlayback, toneMapFilters, type ClientCaps, type PlaybackInput } from './playback'

const APPLE_TV_4K: ClientCaps = {
  videoCodecs: ['h264', 'hevc'],
  maxHeight: 2160,
  hevc10Bit: true,
  dolbyVision: true,
  audioCodecs: ['aac', 'ac3', 'eac3', 'mp3', 'alac', 'flac']
}

const OLD_DEVICE: ClientCaps = {
  videoCodecs: ['h264'],
  maxHeight: 1080,
  hevc10Bit: false,
  dolbyVision: false,
  audioCodecs: ['aac', 'ac3', 'eac3', 'mp3']
}

function probe(overrides: Partial<MediaProbe>): MediaProbe {
  return {
    container: 'matroska',
    videoCodec: 'hevc',
    audioCodec: 'eac3',
    durationSeconds: 7200,
    width: 3840,
    height: 2160,
    bitRateKbps: 20000,
    videoCodecTag: null,
    bitDepth: 10,
    hdr: 'hdr10',
    dolbyVisionProfile: null,
    hasBFrames: true,
    startSeconds: 0,
    audioChannels: 6,
    ...overrides
  }
}

function input(overrides: Partial<PlaybackInput>): PlaybackInput {
  return {
    probe: probe({}),
    extension: '.mkv',
    caps: APPLE_TV_4K,
    bandwidthKbps: 100_000,
    quality: 'auto',
    canRemux: true,
    avoid: [],
    ...overrides
  }
}

describe('decidePlayback', () => {
  it('direct streams a 4K HDR MKV the device can decode, keeping its audio', () => {
    const d = decidePlayback(input({}))
    expect(d.method).toBe('remux')
    expect(d.audio).toBe('copy')
    expect(d.reason).toContain('2160p HEVC HDR10')
  })

  it('converts only the audio when the device can\'t decode it', () => {
    const d = decidePlayback(input({ probe: probe({ audioCodec: 'dts' }) }))
    expect(d.method).toBe('remux')
    expect(d.audio).toBe('convert')
  })

  it('direct plays a compatible MP4 byte for byte', () => {
    const p = probe({ container: 'mov', videoCodecTag: 'hvc1', audioCodec: 'aac' })
    expect(decidePlayback(input({ probe: p, extension: '.mp4' })).method).toBe('direct')
    // hev1-tagged HEVC is refused by Apple players inside MP4.
    const hev1 = { ...p, videoCodecTag: 'hev1' }
    expect(decidePlayback(input({ probe: hev1, extension: '.mp4', canRemux: false })).method).toBe('transcode')
  })

  it('converts down when the connection can\'t carry the original', () => {
    const d = decidePlayback(input({ probe: probe({ bitRateKbps: 60_000 }), bandwidthKbps: 50_000 }))
    expect(d.method).toBe('transcode')
    expect(d.rung).toEqual({ height: 1080, kbps: 8000 })
    expect(d.reason).toContain('60 Mbps')

    const slow = decidePlayback(input({ bandwidthKbps: 7000 }))
    expect(slow.rung?.height).toBe(720)
    const slower = decidePlayback(input({ bandwidthKbps: 1000 }))
    expect(slower.rung?.height).toBe(480)
  })

  it('keeps the original with half again its bitrate to spare', () => {
    expect(decidePlayback(input({ bandwidthKbps: 30_000 })).method).toBe('remux')
    expect(decidePlayback(input({ bandwidthKbps: 29_000 })).method).toBe('transcode')
  })

  it('treats an unknown speed as fast enough', () => {
    expect(decidePlayback(input({ bandwidthKbps: null })).method).toBe('remux')
  })

  it('"original" ignores the connection; a chosen size converts', () => {
    expect(decidePlayback(input({ bandwidthKbps: 1000, quality: 'original' })).method).toBe('remux')
    const d = decidePlayback(input({ quality: '720' }))
    expect(d.method).toBe('transcode')
    expect(d.rung?.height).toBe(720)
  })

  it('a chosen size leaves files already that small alone', () => {
    const p = probe({ videoCodec: 'h264', height: 720, width: 1280, bitDepth: 8, hdr: null, bitRateKbps: 3000 })
    expect(decidePlayback(input({ probe: p, quality: '720' })).method).toBe('remux')
  })

  it('converts what the device can\'t decode', () => {
    expect(decidePlayback(input({ caps: OLD_DEVICE })).method).toBe('transcode')
    const hi10p = probe({ videoCodec: 'h264', bitDepth: 10, height: 1080, hdr: null })
    expect(decidePlayback(input({ probe: hi10p })).method).toBe('transcode')
    expect(decidePlayback(input({ probe: probe({ dolbyVisionProfile: 7 }) })).method).toBe('transcode')
    expect(decidePlayback(input({ probe: probe({ dolbyVisionProfile: 8 }) })).method).toBe('remux')
    expect(decidePlayback(input({ probe: probe({ videoCodec: 'av1' }) })).method).toBe('transcode')
  })

  it('keeps the original audio when converting the picture, if the device plays it', () => {
    const slow = decidePlayback(input({ bandwidthKbps: 7000 }))
    expect(slow.method).toBe('transcode')
    expect(slow.audio).toBe('copy')
    const dts = decidePlayback(input({ bandwidthKbps: 7000, probe: probe({ audioCodec: 'dts' }) }))
    expect(dts.audio).toBe('convert')
  })

  it('converts to HEVC for devices that play it, when the server can encode it', () => {
    const hevc = decidePlayback(input({ quality: '720', hevcEncode: true }))
    expect(hevc.codec).toBe('hevc')
    expect(hevc.rung).toEqual({ height: 720, kbps: 2400 })
    expect(decidePlayback(input({ quality: '720', hevcEncode: false })).codec).toBe('h264')
    expect(decidePlayback(input({ quality: '720', hevcEncode: true, caps: OLD_DEVICE })).codec).toBe('h264')
    // HEVC's lower bitrate fits a slower connection at a bigger size.
    expect(decidePlayback(input({ bandwidthKbps: 7500, hevcEncode: true })).rung?.height).toBe(1080)
    expect(decidePlayback(input({ bandwidthKbps: 7500, hevcEncode: false })).rung?.height).toBe(720)
  })

  it('says when the server upload is the limit', () => {
    const d = decidePlayback(input({ bandwidthKbps: 9000, bandwidthIsServerUpload: true }))
    expect(d.method).toBe('transcode')
    expect(d.reason).toContain('upload the server has spare')
  })

  it('never converts up', () => {
    const p = probe({ videoCodec: 'mpeg4', height: 480, width: 640, bitDepth: 8, hdr: null })
    expect(decidePlayback(input({ probe: p })).rung?.height).toBe(480)
  })

  it('falls back when a method already failed, or the MKV has no index', () => {
    expect(decidePlayback(input({ avoid: ['remux'] })).method).toBe('transcode')
    expect(decidePlayback(input({ canRemux: false })).method).toBe('transcode')
  })
})

describe('toneMapFilters', () => {
  it('maps HDR10 and HLG to SDR, and leaves SDR alone', () => {
    const hdr10 = toneMapFilters(probe({ hdr: 'hdr10' }))
    expect(hdr10[0]).toContain('tin=smpte2084')
    expect(hdr10).toContain('tonemap=tonemap=mobius:desat=0')
    expect(hdr10[hdr10.length - 1]).toBe('zscale=t=bt709:m=bt709:r=tv')
    expect(toneMapFilters(probe({ hdr: 'hlg' }))[0]).toContain('tin=arib-std-b67')
    expect(toneMapFilters(probe({ hdr: null }))).toEqual([])
  })
})
