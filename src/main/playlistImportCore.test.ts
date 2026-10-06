import { describe, expect, it } from 'vitest'
import { artistNames, baseTitle, makeMatcher, parseCsv, readPlaylistCsv, type ImportRow, type LibraryTrack } from './playlistImportCore'

const track = (id: number, title: string, artist: string, album: string, durationSeconds = 200, albumArtist = artist): LibraryTrack => ({
  id,
  title,
  artist,
  albumArtist,
  album,
  durationSeconds
})
const row = (title: string, artist: string, album = '', durationMs: number | null = null): ImportRow => ({ title, artist, album, durationMs, playlist: null })

describe('reading the CSV', () => {
  it('handles quotes, commas and line breaks inside fields', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere']
    ])
  })

  it('reads an Exportify file', () => {
    const csv =
      '"Track URI","Track Name","Artist URI(s)","Artist Name(s)","Album Name","Duration (ms)"\n' +
      '"spotify:track:1","Here Comes the Sun - Remastered 2009","spotify:artist:1","The Beatles","Abbey Road (Remastered)","185733"\n'
    expect(readPlaylistCsv(csv)).toEqual([
      { title: 'Here Comes the Sun - Remastered 2009', artist: 'The Beatles', album: 'Abbey Road (Remastered)', durationMs: 185733, playlist: null }
    ])
  })

  it('reads a TuneMyMusic file with several playlists', () => {
    const csv = 'Track name,Artist name,Album,Playlist name,Type,ISRC\nSong A,Artist,Album,Road Trip,Playlist,X\nSong B,Artist,Album,Chill,Playlist,Y\n'
    expect(readPlaylistCsv(csv).map((r) => r.playlist)).toEqual(['Road Trip', 'Chill'])
  })

  it('says so when a file has no song titles', () => {
    expect(() => readPlaylistCsv('foo,bar\n1,2\n')).toThrow(/song titles/)
  })
})

describe('tidying titles and artists', () => {
  it('drops remaster and feature notes, keeps live versions apart', () => {
    expect(baseTitle('Here Comes the Sun - Remastered 2009')).toBe('here comes the sun')
    expect(baseTitle('Stay (with Justin Bieber)')).toBe('stay')
    expect(baseTitle('Clocks feat. Someone')).toBe('clocks')
    expect(baseTitle('Café del Mar')).toBe('cafe del mar')
    expect(baseTitle('Song (Live)')).not.toBe(baseTitle('Song'))
  })

  it('splits artist lists and ignores "The"', () => {
    expect(artistNames('The Beatles')).toEqual(['beatles'])
    expect(artistNames('Kid Cudi, MGMT & Ratatat feat. Someone')).toEqual(['kid cudi', 'mgmt', 'ratatat', 'someone'])
  })
})

describe('matching songs', () => {
  const library = [
    track(1, 'Here Comes The Sun', 'Beatles', 'Abbey Road', 186),
    track(2, 'Clocks', 'Coldplay', 'A Rush of Blood to the Head', 307),
    track(3, 'Clocks', 'Coldplay', 'Live 2003', 330),
    track(4, 'Stay', 'Some Other Band', 'Other', 210),
    track(5, 'Heroes', 'David Bowie', 'Heroes', 371),
    track(6, 'Pursuit of Happiness (Nightmare)', 'Kid Cudi', 'Man on the Moon', 295, 'Kid Cudi')
  ]
  const m = makeMatcher(library)

  it('finds a song despite remaster notes and "The"', () => {
    expect(m.match(row('Here Comes the Sun - Remastered 2009', 'The Beatles', 'Abbey Road (Remastered)', 185733))).toBe(1)
  })

  it('picks the right album when a song is on two', () => {
    expect(m.match(row('Clocks', 'Coldplay', 'A Rush of Blood to the Head', 307000))).toBe(2)
    expect(m.match(row('Clocks', 'Coldplay', 'Live 2003'))).toBe(3)
  })

  it("won't match the same title by someone else", () => {
    expect(m.match(row('Stay (with Justin Bieber)', 'The Kid LAROI, Justin Bieber'))).toBeNull()
  })

  it('matches a featured artist listed with the main one', () => {
    expect(m.match(row('Pursuit Of Happiness (Nightmare) (feat. MGMT & Ratatat)', 'Kid Cudi, MGMT, Ratatat', 'Man On The Moon: The End Of Day'))).toBe(6)
  })

  it('reports songs that are not there', () => {
    expect(m.match(row('Space Oddity', 'David Bowie'))).toBeNull()
  })
})
