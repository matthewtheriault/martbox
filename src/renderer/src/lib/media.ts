export function imageUrl(path: string | null, port: number): string | undefined {
  if (!path || !port) return undefined
  return `http://127.0.0.1:${port}/image?path=${encodeURIComponent(path)}`
}

// Cast photos are numerous and mostly never seen (nobody scrolls through
// every credit), so unlike posters/backdrops they're deliberately not
// downloaded/cached locally — this links straight to TMDb's CDN, same as
// the uncached search-result posters already do.
export function tmdbImageUrl(path: string | null, size: 'w185' = 'w185'): string | undefined {
  if (!path) return undefined
  return `https://image.tmdb.org/t/p/${size}${path}`
}

export function streamUrl(
  mediaType: 'movie' | 'episode',
  id: number,
  port: number,
  startSeconds?: number
): string {
  const base = `http://127.0.0.1:${port}/stream/${mediaType}/${id}`
  return startSeconds ? `${base}?t=${startSeconds}` : base
}

export function formatRuntime(minutes: number | null): string {
  if (!minutes) return ''
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
