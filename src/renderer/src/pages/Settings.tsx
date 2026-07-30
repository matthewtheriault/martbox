import { useEffect, useState } from 'react'
import type { Library, ScanProgress } from '../../../shared/types'

export default function Settings(): JSX.Element {
  const [libraries, setLibraries] = useState<Library[]>([])
  const [newLibraryType, setNewLibraryType] = useState<'movie' | 'tv'>('movie')
  const [tmdbKey, setTmdbKey] = useState('')
  const [keyStatus, setKeyStatus] = useState<'idle' | 'saving' | 'valid' | 'invalid'>('idle')
  const [scanProgress, setScanProgress] = useState<Record<number, ScanProgress>>({})

  const refreshLibraries = (): void => {
    window.api.library.list().then(setLibraries)
  }

  useEffect(() => {
    refreshLibraries()
    window.api.settings.get().then((s) => setTmdbKey(s.tmdbApiKey ?? ''))
    const unsubscribe = window.api.library.onScanProgress((progress) => {
      setScanProgress((prev) => ({ ...prev, [progress.libraryId]: progress }))
      if (progress.phase === 'done') refreshLibraries()
    })
    return unsubscribe
  }, [])

  const addLibrary = async (): Promise<void> => {
    const path = await window.api.library.pickFolder()
    if (!path) return
    await window.api.library.add(path, newLibraryType)
    refreshLibraries()
  }

  const removeLibrary = async (id: number): Promise<void> => {
    await window.api.library.remove(id)
    refreshLibraries()
  }

  const scanLibrary = async (id: number): Promise<void> => {
    await window.api.library.scan(id)
  }

  const saveKey = async (): Promise<void> => {
    setKeyStatus('saving')
    const valid = await window.api.settings.setTmdbKey(tmdbKey.trim())
    setKeyStatus(valid ? 'valid' : 'invalid')
  }

  return (
    <div className="page">
      <h1 className="page-title">Settings</h1>

      <section className="settings-section">
        <h2>TMDb API Key</h2>
        <p className="settings-hint">
          Used to fetch posters, descriptions, cast, and ratings. Get a free key at{' '}
          themoviedb.org → Settings → API.
        </p>
        <div className="settings-row">
          <input
            type="text"
            placeholder="TMDb API Key"
            value={tmdbKey}
            onChange={(e) => setTmdbKey(e.target.value)}
          />
          <button className="btn-primary" onClick={saveKey}>
            Save
          </button>
        </div>
        {keyStatus === 'valid' && <p className="settings-status-ok">Key saved and verified.</p>}
        {keyStatus === 'invalid' && <p className="settings-status-error">That key didn't work.</p>}
      </section>

      <section className="settings-section">
        <h2>Libraries</h2>
        <div className="settings-row">
          <select value={newLibraryType} onChange={(e) => setNewLibraryType(e.target.value as 'movie' | 'tv')}>
            <option value="movie">Movies</option>
            <option value="tv">TV Shows</option>
          </select>
          <button className="btn-primary" onClick={addLibrary}>
            Add Library Folder
          </button>
        </div>

        <ul className="library-list">
          {libraries.map((lib) => {
            const progress = scanProgress[lib.id]
            return (
              <li key={lib.id} className="library-item">
                <div>
                  <div className="library-name">
                    {lib.name} <span className="library-type">({lib.type})</span>
                  </div>
                  <div className="library-path">{lib.path}</div>
                  {progress && progress.phase !== 'done' && (
                    <div className="library-scan-status">
                      {progress.phase === 'scanning'
                        ? 'Scanning files…'
                        : `Matching metadata (${progress.current}/${progress.total}) ${progress.message}`}
                    </div>
                  )}
                </div>
                <div className="library-actions">
                  <button className="btn-secondary" onClick={() => scanLibrary(lib.id)}>
                    Scan
                  </button>
                  <button className="btn-danger" onClick={() => removeLibrary(lib.id)}>
                    Remove
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
