import { useEffect, useRef, useState } from 'react'
import type { Collection } from '../../../shared/types'
import { useProfile } from '../lib/ProfileContext'

// Admin only: put this movie or show in (or take it out of) collections,
// or start a new one with it.
export default function AddToCollection({
  mediaType,
  mediaId
}: {
  mediaType: 'movie' | 'show'
  mediaId: number
}): JSX.Element | null {
  const { activeProfile, profilePin } = useProfile()
  const [open, setOpen] = useState(false)
  const [collections, setCollections] = useState<Collection[]>([])
  const [inside, setInside] = useState<Set<number>>(new Set())
  const [newName, setNewName] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    window.api.collections.list().then(setCollections).catch(() => {})
    window.api.collections
      .containing(mediaType, mediaId)
      .then((ids) => setInside(new Set(ids)))
      .catch(() => {})
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open, mediaType, mediaId])

  if (!activeProfile.isAdmin) return null

  const toggle = async (c: Collection): Promise<void> => {
    const has = inside.has(c.id)
    await window.api.collections.item(activeProfile.id, profilePin, c.id, {
      mediaType,
      mediaId,
      action: has ? 'remove' : 'add'
    })
    const next = new Set(inside)
    if (has) next.delete(c.id)
    else next.add(c.id)
    setInside(next)
  }

  const createWithThis = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    const made = await window.api.collections.create(activeProfile.id, profilePin, name)
    await window.api.collections.item(activeProfile.id, profilePin, made.id, { mediaType, mediaId, action: 'add' })
    setNewName('')
    setCollections((cs) => [...cs, made])
    setInside((s) => new Set([...s, made.id]))
  }

  return (
    <div className="add-collection" ref={ref}>
      <button className="btn-secondary" onClick={() => setOpen((v) => !v)}>
        {inside.size > 0 && !open ? '✓ In a Collection' : 'Add to Collection'}
      </button>
      {open && (
        <div className="add-collection-menu">
          {collections.map((c) => (
            <button key={c.id} onClick={() => void toggle(c)}>
              <span>{c.name}</span>
              {inside.has(c.id) && <span className="check">✓</span>}
            </button>
          ))}
          <div className="add-collection-new">
            <input
              className="input"
              placeholder="New collection"
              maxLength={80}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void createWithThis()}
            />
            <button className="btn-primary" disabled={!newName.trim()} onClick={() => void createWithThis()}>
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
