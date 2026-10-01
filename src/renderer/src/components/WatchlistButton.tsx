import { useEffect, useState } from 'react'
import type { WatchlistMediaType } from '../../../shared/types'

interface WatchlistButtonProps {
  profileId: number
  pin: string | null
  mediaType: WatchlistMediaType
  mediaId: number
}

export default function WatchlistButton({
  profileId,
  pin,
  mediaType,
  mediaId
}: WatchlistButtonProps): JSX.Element {
  const [inWatchlist, setInWatchlist] = useState<boolean | null>(null)

  useEffect(() => {
    window.api.watchlist.has(profileId, mediaType, mediaId, pin).then(setInWatchlist)
  }, [profileId, mediaType, mediaId, pin])

  const toggle = async (): Promise<void> => {
    if (inWatchlist) {
      await window.api.watchlist.remove(profileId, mediaType, mediaId, pin)
      setInWatchlist(false)
    } else {
      await window.api.watchlist.add(profileId, mediaType, mediaId, pin)
      setInWatchlist(true)
    }
  }

  return (
    <button className="btn-secondary" onClick={toggle} disabled={inWatchlist === null}>
      {inWatchlist ? 'In Watchlist' : 'Add to Watchlist'}
    </button>
  )
}
