import { describe, expect, it } from 'vitest'
import { parseTrack, sortKey } from './musicCore'

const flac = {
  format: {
    duration: '213.4',
    tags: {
      TITLE: 'Wave 1',
      ARTIST: 'Test Artist',
      ALBUMARTIST: 'Various',
      ALBUM: 'Sine Waves',
      DATE: '2021-03-04',
      TRACKNUMBER: '1/12',
      DISCNUMBER: '2',
      GENRE: 'Ambient',
      REPLAYGAIN_TRACK_GAIN: '-6.20 dB'
    }
  },
  streams: [
    { codec_type: 'audio', codec_name: 'flac', sample_rate: '96000', bits_per_raw_sample: '24', channels: 2 },
    { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }
  ]
}

describe('reading tags', () => {
  it('reads Vorbis comments, whatever their case', () => {
    const t = parseTrack('/m/Test Artist/Sine Waves/01 Wave 1.flac', flac)
    expect(t).toMatchObject({
      title: 'Wave 1',
      artist: 'Test Artist',
      albumArtist: 'Various',
      album: 'Sine Waves',
      trackNumber: 1,
      discNumber: 2,
      year: 2021,
      genre: 'Ambient',
      durationSeconds: 213.4,
      codec: 'flac',
      sampleRate: 96000,
      bitDepth: 24,
      hasEmbeddedCover: true,
      trackGain: -6.2
    })
  })

  it('falls back to folder and file names when there are no tags', () => {
    const t = parseTrack('/m/Some Band/Great Album (1999)/1-07 - Song Name.mp3', {
      format: { duration: '100' },
      streams: [{ codec_type: 'audio', codec_name: 'mp3', bits_per_raw_sample: '0', bit_rate: '320000' }]
    })
    expect(t).toMatchObject({
      title: 'Song Name',
      artist: 'Some Band',
      albumArtist: 'Some Band',
      album: 'Great Album',
      year: 1999,
      trackNumber: 7,
      discNumber: 1,
      bitDepth: null,
      bitrateKbps: 320
    })
  })

  it('handles "Year - Album" folders and lower-case ID3 names', () => {
    const t = parseTrack('/m/X/2004 - Late Album/02 Two.mp3', {
      format: { duration: '1', tags: { title: 'Two', artist: 'X', track: '2' } },
      streams: [{ codec_type: 'audio', codec_name: 'mp3' }]
    })
    expect(t.album).toBe('Late Album')
    expect(t.year).toBe(2004)
    expect(t.trackNumber).toBe(2)
  })
})

describe('sorting', () => {
  it('ignores a leading article', () => {
    expect(['The Zebras', 'Apples', 'A Band'].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))).toEqual([
      'Apples',
      'A Band',
      'The Zebras'
    ])
  })
})
