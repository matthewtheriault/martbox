import { basename, dirname, extname } from 'path'

// Reading a music file's tags (from ffprobe's JSON) into what the library
// stores. Pure, so it's tested without files.

export const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.m4a', '.aac', '.alac', '.ogg', '.oga', '.opus', '.wav', '.aif', '.aiff'])

export interface TrackTags {
  title: string
  artist: string
  albumArtist: string
  album: string
  trackNumber: number | null
  discNumber: number
  year: number | null
  genre: string | null
  durationSeconds: number
  codec: string | null
  sampleRate: number | null
  bitDepth: number | null
  channels: number | null
  bitrateKbps: number | null
  hasEmbeddedCover: boolean
  // ReplayGain, when the file carries it (dB).
  trackGain: number | null
  albumGain: number | null
}

function firstNumber(value: unknown): number | null {
  const m = String(value ?? '').match(/\d+/)
  return m ? parseInt(m[0], 10) : null
}

function gain(value: unknown): number | null {
  const n = parseFloat(String(value ?? '').replace(/dB/i, ''))
  return Number.isFinite(n) ? n : null
}

// Tag names differ between formats (Vorbis comments are upper case, ID3
// and MP4 are mapped by ffprobe to lower case, some use spaces).
function normalizedTags(...sources: (Record<string, unknown> | undefined)[]): Map<string, string> {
  const tags = new Map<string, string>()
  for (const source of sources) {
    for (const [k, v] of Object.entries(source ?? {})) {
      const key = k.toLowerCase().replace(/[\s_-]/g, '')
      if (!tags.has(key) && v !== undefined && v !== null && String(v).trim() !== '') tags.set(key, String(v).trim())
    }
  }
  return tags
}

// Folder names like "Album (2021)" or "2021 - Album".
function albumFromFolder(folder: string): { album: string; year: number | null } {
  const m = folder.match(/^(.*?)\s*[([](\d{4})[)\]]\s*$/) ?? folder.match(/^(\d{4})\s*-\s*(.*)$/)
  if (!m) return { album: folder, year: null }
  return /^\d{4}$/.test(m[1]) ? { album: m[2], year: parseInt(m[1], 10) } : { album: m[1], year: parseInt(m[2], 10) }
}

// Files named "03 Title.flac" or "1-03 - Title.mp3".
function titleFromFile(file: string): { title: string; track: number | null; disc: number | null } {
  const name = basename(file, extname(file))
  const m = name.match(/^(?:(\d{1,2})[-.])?(\d{1,3})\s*[-.]?\s+(.+)$/)
  if (!m) return { title: name, track: null, disc: null }
  return { title: m[3], track: parseInt(m[2], 10), disc: m[1] ? parseInt(m[1], 10) : null }
}

export function parseTrack(filePath: string, probe: any): TrackTags {
  const audio = (probe?.streams ?? []).find((s: any) => s.codec_type === 'audio')
  const cover = (probe?.streams ?? []).some((s: any) => s.codec_type === 'video' && s.disposition?.attached_pic === 1)
  const tags = normalizedTags(probe?.format?.tags, audio?.tags)
  const folder = albumFromFolder(basename(dirname(filePath)))
  const parentFolder = basename(dirname(dirname(filePath)))
  const fromFile = titleFromFile(filePath)
  const artist = tags.get('artist') ?? tags.get('albumartist') ?? parentFolder ?? 'Unknown Artist'
  const year = firstNumber(tags.get('date') ?? tags.get('year') ?? tags.get('originaldate')) ?? folder.year
  const bits = firstNumber(audio?.bits_per_raw_sample) ?? firstNumber(audio?.bits_per_sample)
  const bitrate = firstNumber(audio?.bit_rate) ?? firstNumber(probe?.format?.bit_rate)
  return {
    title: tags.get('title') ?? fromFile.title,
    artist,
    albumArtist: tags.get('albumartist') ?? tags.get('albumartists') ?? artist,
    album: tags.get('album') ?? folder.album,
    trackNumber: firstNumber(tags.get('track') ?? tags.get('tracknumber')) ?? fromFile.track,
    discNumber: firstNumber(tags.get('disc') ?? tags.get('discnumber')) ?? fromFile.disc ?? 1,
    year: year && year > 1000 && year < 3000 ? year : null,
    genre: tags.get('genre') ?? null,
    durationSeconds: parseFloat(probe?.format?.duration ?? audio?.duration ?? '0') || 0,
    codec: audio?.codec_name ?? null,
    sampleRate: firstNumber(audio?.sample_rate),
    // Lossy codecs report no meaningful bit depth.
    bitDepth: bits && bits > 0 && ['flac', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_s16be', 'pcm_s24be'].includes(audio?.codec_name) ? bits : null,
    channels: firstNumber(audio?.channels),
    bitrateKbps: bitrate ? Math.round(bitrate / 1000) : null,
    hasEmbeddedCover: cover,
    trackGain: gain(tags.get('replaygaintrackgain')),
    albumGain: gain(tags.get('replaygainalbumgain')),
  }
}

export const LOSSLESS_CODECS = new Set(['flac', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_s16be', 'pcm_s24be', 'wavpack'])

// Sorting that ignores a leading "The " / "A " and case, like most players.
export function sortKey(name: string): string {
  return name.replace(/^(the|a|an)\s+/i, '').toLowerCase()
}

// A genre tag can hold several ("Rock; Indie", or ID3v2.4's NUL-separated
// list); each counts on its own. Case is folded for matching but the first
// spelling seen is kept for display.
export function splitGenres(tag: string | null | undefined): string[] {
  if (!tag) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of tag.split(/[;\0]|\s\/\s/)) {
    const name = part.trim()
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push(name)
  }
  return out
}
