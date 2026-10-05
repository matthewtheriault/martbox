import { describe, expect, it } from 'vitest'
import { genresFromDb, genresToDb } from './genres'

describe('stored genres', () => {
  it('round-trips the library format', () => {
    expect(genresToDb(['Science Fiction', 'Action'])).toBe('Science Fiction, Action')
    expect(genresFromDb('Science Fiction, Action')).toEqual(['Science Fiction', 'Action'])
    expect(genresToDb([])).toBeNull()
    expect(genresFromDb(null)).toEqual([])
  })

  it('reads a JSON list too', () => {
    expect(genresFromDb('["Science Fiction","Action"]')).toEqual(['Science Fiction', 'Action'])
  })
})
