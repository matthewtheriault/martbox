import { useEffect, useState } from 'react'
import { usePort } from '../lib/PortContext'

// A glow at the top of a page in its artwork's colour (the server picks it:
// /api/art-color). Put it first inside a positioned page; it sits behind
// the content. `query`: "kind=album&id=3", "kind=image&path=…"; null for none.
export default function ArtTint({ query }: { query: string | null }): JSX.Element | null {
  const port = usePort()
  const [color, setColor] = useState<string | null>(null)
  useEffect(() => {
    setColor(null)
    if (!query) return
    let live = true
    fetch(`http://127.0.0.1:${port}/api/art-color?${query}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { color: string | null } | null) => live && setColor(d?.color ?? null))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [port, query])
  if (!color) return null
  return <div className="art-tint" style={{ '--art': color } as React.CSSProperties} aria-hidden="true" />
}
