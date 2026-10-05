// How a movie's or show's genres are kept in the database: "Drama, Comedy".
// Shared by the library (repository.ts) and Live Channels (channels.ts), so
// both read them the same way.

export function genresToDb(genres: string[] | undefined): string | null {
  return genres && genres.length > 0 ? genres.join(', ') : null
}

export function genresFromDb(stored: string | null): string[] {
  if (!stored) return []
  // Older rows may hold a JSON list.
  if (stored.startsWith('[')) {
    try {
      const list = JSON.parse(stored)
      if (Array.isArray(list)) return list.filter((g): g is string => typeof g === 'string' && g.length > 0)
    } catch {
      /* not JSON after all: fall through */
    }
  }
  return stored.split(', ').filter(Boolean)
}
