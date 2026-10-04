import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Collection } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { useProfile } from '../lib/ProfileContext'
import { imageUrl } from '../lib/media'
import PosterCard from '../components/PosterCard'

// /collections: every collection the admin made. /collections/:id: one of
// them, which the admin can rename, reorder and prune here.
export default function Collections(): JSX.Element {
  const { id } = useParams<{ id: string }>()
  return id ? <CollectionPage id={Number(id)} /> : <CollectionList />
}

function CollectionList(): JSX.Element {
  const port = usePort()
  const navigate = useNavigate()
  const { activeProfile, profilePin } = useProfile()
  const [collections, setCollections] = useState<Collection[] | null>(null)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.collections.list().then(setCollections).catch(() => setCollections([]))
  }, [])

  const create = async (): Promise<void> => {
    if (!newName.trim()) return
    try {
      const made = await window.api.collections.create(activeProfile.id, profilePin, newName.trim())
      navigate(`/collections/${made.id}`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="page">
      <h1 className="page-title">Collections</h1>
      <p className="page-subtitle">
        {activeProfile.isAdmin
          ? 'Group movies and shows your way. Add titles from their page with “Add to Collection”.'
          : 'Movies and shows grouped by the admin.'}
      </p>

      {activeProfile.isAdmin && (
        <div className="collection-new">
          <input
            className="input"
            placeholder="New collection name"
            value={newName}
            maxLength={80}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
          <button className="btn-primary" disabled={!newName.trim()} onClick={() => void create()}>
            Create
          </button>
          {error && <span className="form-error">{error}</span>}
        </div>
      )}

      {collections && collections.length === 0 && (
        <p className="empty-state-inline">No collections yet.</p>
      )}

      <div className="collection-grid">
        {collections?.map((c) => (
          <button key={c.id} className="collection-card" onClick={() => navigate(`/collections/${c.id}`)}>
            <div className="collection-collage">
              {c.items.slice(0, 4).map((item) => (
                <div key={`${item.mediaType}-${item.id}`} className="collection-collage-cell">
                  {item.posterPath && <img src={imageUrl(item.posterPath, port)} alt="" loading="lazy" />}
                </div>
              ))}
              {Array.from({ length: Math.max(0, 4 - c.items.length) }, (_, i) => (
                <div key={`empty-${i}`} className="collection-collage-cell" />
              ))}
            </div>
            <span className="collection-card-name">{c.name}</span>
            <span className="collection-card-count">
              {c.items.length === 1 ? '1 title' : `${c.items.length} titles`}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function CollectionPage({ id }: { id: number }): JSX.Element {
  const port = usePort()
  const navigate = useNavigate()
  const { activeProfile, profilePin } = useProfile()
  const [collection, setCollection] = useState<Collection | null | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const admin = activeProfile.isAdmin

  useEffect(() => {
    window.api.collections
      .get(id)
      .then((c) => {
        setCollection(c)
        setName(c.name)
        setDescription(c.description)
      })
      .catch(() => setCollection(null))
  }, [id])

  if (collection === undefined) return <div className="page" />
  if (collection === null) {
    return (
      <div className="page">
        <h1 className="page-title">Collection not found</h1>
        <button className="btn-secondary" onClick={() => navigate('/collections')}>
          All collections
        </button>
      </div>
    )
  }

  const save = async (): Promise<void> => {
    setCollection(await window.api.collections.update(activeProfile.id, profilePin, id, { name, description }))
    setEditing(false)
  }
  const change = async (
    mediaType: 'movie' | 'show',
    mediaId: number,
    action: 'remove' | 'move',
    toIndex?: number
  ): Promise<void> => {
    setCollection(
      await window.api.collections.item(activeProfile.id, profilePin, id, { mediaType, mediaId, action, toIndex })
    )
  }

  return (
    <div className="page">
      <button className="link-button" onClick={() => navigate('/collections')}>
        ← Collections
      </button>
      {editing ? (
        <div className="collection-edit">
          <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <textarea
            className="input"
            placeholder="What's in it (optional)"
            value={description}
            maxLength={300}
            rows={2}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="detail-actions">
            <button className="btn-primary" disabled={!name.trim()} onClick={() => void save()}>
              Save
            </button>
            <button className="btn-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <h1 className="page-title">{collection.name}</h1>
          {collection.description && <p className="page-subtitle">{collection.description}</p>}
        </>
      )}

      {admin && !editing && (
        <div className="detail-actions collection-actions">
          <button className="btn-secondary" onClick={() => setEditing(true)}>
            Rename
          </button>
          <button
            className="btn-secondary"
            onClick={async () =>
              setCollection(
                await window.api.collections.update(activeProfile.id, profilePin, id, {
                  onHome: !collection.onHome
                })
              )
            }
          >
            {collection.onHome ? '✓ Shown on Home' : 'Show on Home'}
          </button>
          <button
            className="btn-danger"
            onClick={async () => {
              if (!confirmDelete) {
                setConfirmDelete(true)
                return
              }
              await window.api.collections.remove(activeProfile.id, profilePin, id)
              navigate('/collections')
            }}
          >
            {confirmDelete ? 'Delete this collection?' : 'Delete'}
          </button>
        </div>
      )}

      {collection.items.length === 0 ? (
        <p className="empty-state-inline">
          {admin ? 'Empty so far. Open a movie or show and choose “Add to Collection”.' : 'Nothing here yet.'}
        </p>
      ) : (
        <div className="grid">
          {collection.items.map((item, i) => (
            <div key={`${item.mediaType}-${item.id}`} className="collection-item">
              <PosterCard
                title={item.title}
                subtitle={item.year ? String(item.year) : null}
                posterUrl={imageUrl(item.posterPath, port)}
                onClick={() => navigate(item.mediaType === 'movie' ? `/movie/${item.id}` : `/show/${item.id}`)}
              />
              {admin && (
                <div className="collection-item-tools">
                  <button
                    title="Move earlier"
                    disabled={i === 0}
                    onClick={() => void change(item.mediaType, item.id, 'move', i - 1)}
                  >
                    ←
                  </button>
                  <button title="Remove" onClick={() => void change(item.mediaType, item.id, 'remove')}>
                    Remove
                  </button>
                  <button
                    title="Move later"
                    disabled={i === collection.items.length - 1}
                    onClick={() => void change(item.mediaType, item.id, 'move', i + 1)}
                  >
                    →
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
