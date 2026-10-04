import { useEffect } from 'react'

// A title's trailer, played in YouTube's embedded player over the page.
export default function TrailerModal({
  youtubeKey,
  onClose
}: {
  youtubeKey: string
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="trailer-modal" onClick={onClose}>
      <div className="trailer-frame" onClick={(e) => e.stopPropagation()}>
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeKey)}?autoplay=1&rel=0`}
          title="Trailer"
          allow="autoplay; encrypted-media; fullscreen"
          allowFullScreen
        />
      </div>
      <div className="trailer-actions" onClick={(e) => e.stopPropagation()}>
        <button
          className="btn-secondary"
          onClick={() => window.api.system.openExternal(`https://www.youtube.com/watch?v=${youtubeKey}`)}
        >
          Open in YouTube
        </button>
        <button className="btn-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
