import { useEffect, useState } from 'react'
import { musicPlayer, type MusicState } from './musicPlayer'

// The music player's state, kept current.
export function useMusic(): MusicState {
  const [state, setState] = useState(musicPlayer.state)
  useEffect(() => musicPlayer.subscribe(setState), [])
  return state
}
