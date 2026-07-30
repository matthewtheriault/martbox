export function imageUrl(path: string | null, port: number): string | undefined {
  if (!path || !port) return undefined
  return `http://127.0.0.1:${port}/image?path=${encodeURIComponent(path)}`
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

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
