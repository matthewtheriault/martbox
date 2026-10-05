import { useEffect, useState } from 'react'

// Which player has the speakers: music or an audiobook. Starting one pauses
// the other, and the bottom bar shows whichever was used last.

export type AudioOwner = 'music' | 'book'

let owner: AudioOwner | null = null
const listeners = new Set<(o: AudioOwner | null) => void>()
const pausers = new Map<AudioOwner, () => void>()

export function onFocusLost(who: AudioOwner, pause: () => void): void {
  pausers.set(who, pause)
}

export function takeFocus(who: AudioOwner): void {
  if (owner === who) return
  if (owner) pausers.get(owner)?.()
  owner = who
  for (const fn of listeners) fn(owner)
}

export function useAudioFocus(): AudioOwner | null {
  const [value, setValue] = useState(owner)
  useEffect(() => {
    listeners.add(setValue)
    return () => {
      listeners.delete(setValue)
    }
  }, [])
  return value
}
