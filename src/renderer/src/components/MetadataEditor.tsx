import { useState } from 'react'

interface SearchResult {
  tmdbId: number
  title: string
  year: number | null
  overview: string
  posterPath: string | null
}

interface MetadataEditorProps {
  title: string
  year: number | null
  overview: string
  onSearch: (query: string) => Promise<SearchResult[]>
  onApplyMatch: (tmdbId: number) => Promise<void>
  onManualSave: (patch: { title: string; year: number | null; overview: string }) => Promise<void>
  onClose: () => void
}

export default function MetadataEditor({
  title,
  year,
  overview,
  onSearch,
  onApplyMatch,
  onManualSave,
  onClose
}: MetadataEditorProps): JSX.Element {
  const [tab, setTab] = useState<'manual' | 'search'>('manual')
  const [manualTitle, setManualTitle] = useState(title)
  const [manualYear, setManualYear] = useState(year ? String(year) : '')
  const [manualOverview, setManualOverview] = useState(overview)
  const [saving, setSaving] = useState(false)

  const [query, setQuery] = useState(title)
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [applyingId, setApplyingId] = useState<number | null>(null)

  const runSearch = async (): Promise<void> => {
    const trimmed = query.trim()
    if (!trimmed) return
    setSearching(true)
    const r = await onSearch(trimmed)
    setResults(r)
    setSearching(false)
  }

  const pick = async (tmdbId: number): Promise<void> => {
    setApplyingId(tmdbId)
    await onApplyMatch(tmdbId)
    setApplyingId(null)
    onClose()
  }

  const saveManual = async (): Promise<void> => {
    setSaving(true)
    await onManualSave({
      title: manualTitle.trim(),
      year: manualYear.trim() ? parseInt(manualYear.trim(), 10) : null,
      overview: manualOverview.trim()
    })
    setSaving(false)
    onClose()
  }

  return (
    <div className="metadata-editor">
      <div className="season-tabs">
        <button
          className={tab === 'manual' ? 'season-tab active' : 'season-tab'}
          onClick={() => setTab('manual')}
        >
          Edit Manually
        </button>
        <button
          className={tab === 'search' ? 'season-tab active' : 'season-tab'}
          onClick={() => setTab('search')}
        >
          Search TMDb
        </button>
      </div>

      {tab === 'manual' && (
        <div className="metadata-editor-form">
          <label>Title</label>
          <input type="text" value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} />
          <label>Year</label>
          <input
            type="text"
            inputMode="numeric"
            value={manualYear}
            onChange={(e) => setManualYear(e.target.value)}
          />
          <label>Overview</label>
          <textarea
            value={manualOverview}
            onChange={(e) => setManualOverview(e.target.value)}
            rows={4}
          />
          <div className="profile-picker-form-actions">
            <button className="btn-primary" onClick={saveManual} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {tab === 'search' && (
        <div className="metadata-editor-form">
          <div className="settings-row">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              placeholder="Search title…"
              autoFocus
            />
            <button className="btn-primary" onClick={runSearch}>
              {searching ? 'Searching…' : 'Search'}
            </button>
          </div>
          {results && (
            <div className="metadata-search-results">
              {results.length === 0 && <p className="settings-hint">No results.</p>}
              {results.map((r) => (
                <button
                  key={r.tmdbId}
                  className="metadata-search-result"
                  onClick={() => pick(r.tmdbId)}
                  disabled={applyingId !== null}
                >
                  {r.posterPath ? (
                    <img
                      src={`https://image.tmdb.org/t/p/w154${r.posterPath}`}
                      alt={r.title}
                    />
                  ) : (
                    <div className="metadata-search-result-noposter" />
                  )}
                  <div className="metadata-search-result-info">
                    <div className="metadata-search-result-title">
                      {r.title}
                      {r.year ? ` (${r.year})` : ''}
                    </div>
                    <div className="metadata-search-result-overview">{r.overview}</div>
                  </div>
                  {applyingId === r.tmdbId && <span className="settings-hint">Applying…</span>}
                </button>
              ))}
            </div>
          )}
          <div className="profile-picker-form-actions">
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
