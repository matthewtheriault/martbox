import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  MediaRequest,
  MediaRequestStatus,
  RequestDiscover,
  RequestTitleDetails,
  RequestableTitle
} from '../../../shared/types'
import { useProfile } from '../lib/ProfileContext'
import PosterCard from '../components/PosterCard'
import Row from '../components/Row'

// Friends ask for movies and shows that aren't on MartBox yet; the admin
// handles them in the Dashboard (src/main/requests.ts). Browsing and search
// go through the server, which talks to TMDB.

export const REQUEST_STATUS_LABEL: Record<MediaRequestStatus, string> = {
  pending: 'Requested',
  approved: 'Approved',
  declined: 'Declined',
  available: 'Available'
}

export function seasonsLabel(seasons: number[] | null): string {
  if (!seasons || seasons.length === 0) return ''
  if (seasons.length === 1) return `Season ${seasons[0]}`
  const contiguous = seasons.every((s, i) => i === 0 || s === seasons[i - 1] + 1)
  return contiguous
    ? `Seasons ${seasons[0]}–${seasons[seasons.length - 1]}`
    : `Seasons ${seasons.join(', ')}`
}

function badgeFor(item: RequestableTitle): string | undefined {
  if (item.onServer) return 'On MartBox'
  if (item.requestStatus) return REQUEST_STATUS_LABEL[item.requestStatus]
  return undefined
}

function RequestDetail({
  item,
  onClose,
  onRequested
}: {
  item: RequestableTitle
  onClose: () => void
  onRequested: () => void
}): JSX.Element {
  const { activeProfile, profilePin } = useProfile()
  const navigate = useNavigate()
  const [details, setDetails] = useState<RequestTitleDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = (): void => {
    window.api.requests
      .title(item.mediaType, item.tmdbId)
      .then((d) => {
        setDetails(d)
        // Pre-tick every season that isn't already covered.
        const covered = takenSeasons(d)
        setPicked(new Set(d.seasons.map((s) => s.number).filter((n) => !covered.has(n))))
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  useEffect(load, [item.mediaType, item.tmdbId])

  const submit = async (): Promise<void> => {
    if (!details) return
    setBusy(true)
    setMessage(null)
    try {
      const seasons = details.mediaType === 'tv' ? [...picked].sort((a, b) => a - b) : null
      const result = await window.api.requests.create(
        activeProfile.id,
        profilePin,
        details.mediaType,
        details.tmdbId,
        seasons
      )
      if (result.ok) {
        setMessage('Requested — you’ll see it here when it’s added.')
        onRequested()
        load()
      } else if (result.reason === 'already-requested') {
        setMessage(`Already requested${result.by ? ` by ${result.by}` : ''}.`)
      } else if (result.reason === 'in-library') {
        setMessage('That’s already on MartBox.')
      } else {
        setMessage('Pick at least one season.')
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const covered = details ? takenSeasons(details) : new Set<number>()
  const library = details?.library
  const open = details?.requests ?? []
  const fullyOnServer =
    !!library &&
    (details?.mediaType === 'movie' || details?.seasons.every((s) => covered.has(s.number)))
  const pickSeasons = details?.mediaType === 'tv' && details.seasons.length > 0
  const movieRequested = details?.mediaType === 'movie' && open.length > 0
  // "Your Requests" cards don't carry one; the loaded details do.
  const backdropUrl = details?.backdropUrl ?? item.backdropUrl

  return (
    <div className="req-modal-backdrop" onClick={onClose}>
      <div className="req-modal" onClick={(e) => e.stopPropagation()}>
        {backdropUrl && <img className="req-modal-backdrop-img" src={backdropUrl} alt="" />}
        <button className="req-modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className={backdropUrl ? 'req-modal-body req-modal-body-over' : 'req-modal-body'}>
          {item.posterUrl && <img className="req-modal-poster" src={item.posterUrl} alt="" />}
          <div className="req-modal-info">
            <h2>
              {item.title}
              {item.year && <span className="req-modal-year"> ({item.year})</span>}
            </h2>
            {details && (
              <div className="req-modal-meta">
                {details.mediaType === 'movie' ? 'Movie' : 'TV show'}
                {details.genres.length > 0 && ` · ${details.genres.slice(0, 3).join(', ')}`}
                {details.runtimeMinutes ? ` · ${details.runtimeMinutes} min` : ''}
              </div>
            )}
            <p className="req-modal-overview">{item.overview}</p>
            {error && <p className="req-error">{error}</p>}

            {details && library && (
              <div className="req-on-server">
                <span className="dash-badge dash-badge-good">On MartBox</span>
                {details.mediaType === 'tv' && library.seasons.length > 0 && (
                  <span className="dash-dim"> {seasonsLabel(library.seasons)}</span>
                )}
                <button
                  className="btn-secondary"
                  onClick={() =>
                    navigate(
                      library.movieId ? `/movie/${library.movieId}` : `/show/${library.showId}`
                    )
                  }
                >
                  Play
                </button>
              </div>
            )}

            {open.map((r) => (
              <div key={r.id} className="req-existing">
                {REQUEST_STATUS_LABEL[r.status]} by {r.profileName || 'someone'}
                {r.seasons && ` · ${seasonsLabel(r.seasons)}`}
              </div>
            ))}

            {details && pickSeasons && !fullyOnServer && (
              <div className="req-seasons">
                {details.seasons.map((season) => {
                  const taken = covered.has(season.number)
                  return (
                    <label
                      key={season.number}
                      className={taken ? 'req-season taken' : 'req-season'}
                    >
                      <input
                        type="checkbox"
                        disabled={taken}
                        checked={taken || picked.has(season.number)}
                        onChange={(e) => {
                          const next = new Set(picked)
                          if (e.target.checked) next.add(season.number)
                          else next.delete(season.number)
                          setPicked(next)
                        }}
                      />
                      {season.name}
                      <span className="dash-dim">
                        {' '}
                        · {season.episodeCount} ep{season.airYear ? ` · ${season.airYear}` : ''}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}

            {details && !fullyOnServer && !movieRequested && (
              <button
                className="btn-primary"
                disabled={busy || (pickSeasons && picked.size === 0)}
                onClick={submit}
              >
                {pickSeasons
                  ? `Request ${picked.size === 1 ? '1 season' : `${picked.size} seasons`}`
                  : 'Request'}
              </button>
            )}
            {message && <p className="req-message">{message}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}

// Seasons already on the server or already asked for.
function takenSeasons(details: RequestTitleDetails): Set<number> {
  const all = details.seasons.map((s) => s.number)
  const taken = new Set(details.library?.seasons ?? [])
  for (const r of details.requests) for (const s of r.seasons ?? all) taken.add(s)
  return taken
}

export default function Requests(): JSX.Element {
  const { activeProfile, profilePin } = useProfile()
  const navigate = useNavigate()
  const [discover, setDiscover] = useState<RequestDiscover | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RequestableTitle[] | null>(null)
  const [mine, setMine] = useState<MediaRequest[]>([])
  const [selected, setSelected] = useState<RequestableTitle | null>(null)

  const loadMine = (): void => {
    window.api.requests
      .mine(activeProfile.id, profilePin)
      .then(setMine)
      .catch(() => {})
  }

  useEffect(() => {
    window.api.requests
      .discover()
      .then(setDiscover)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    loadMine()
  }, [activeProfile.id])

  // Search as you type, after a short pause.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      return
    }
    const timer = setTimeout(() => {
      window.api.requests
        .search(q)
        .then(setResults)
        .catch(() => setResults([]))
    }, 350)
    return () => clearTimeout(timer)
  }, [query])

  const card = (item: RequestableTitle): JSX.Element => (
    <PosterCard
      key={`${item.mediaType}-${item.tmdbId}`}
      title={item.title}
      subtitle={item.year ?? undefined}
      posterUrl={item.posterUrl ?? undefined}
      badge={badgeFor(item)}
      onClick={() => setSelected(item)}
    />
  )

  return (
    <div className="page">
      <div className="page-title-row">
        <h1 className="page-title">Requests</h1>
      </div>
      <p className="dash-summary">Ask for a movie or show that isn’t on MartBox yet.</p>
      <input
        className="req-search"
        type="search"
        placeholder="Search movies and TV shows…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {mine.length > 0 && !results && (
        <Row title="Your Requests">
          {mine.map((r) => (
            <PosterCard
              key={r.id}
              title={r.title}
              subtitle={
                <>
                  <span className={`req-status req-status-${r.status}`}>
                    {REQUEST_STATUS_LABEL[r.status]}
                  </span>
                  {r.seasons ? ` · ${seasonsLabel(r.seasons)}` : ''}
                </>
              }
              posterUrl={r.posterUrl ?? undefined}
              onClick={() => {
                if (r.libraryMovieId) navigate(`/movie/${r.libraryMovieId}`)
                else if (r.libraryShowId) navigate(`/show/${r.libraryShowId}`)
                else
                  setSelected({
                    tmdbId: r.tmdbId,
                    mediaType: r.mediaType,
                    title: r.title,
                    year: r.year,
                    overview: '',
                    posterUrl: r.posterUrl,
                    backdropUrl: null,
                    rating: null
                  })
              }}
            />
          ))}
        </Row>
      )}

      {error && <p className="empty-state-inline">{error}</p>}

      {results ? (
        results.length === 0 ? (
          <p className="empty-state-inline">Nothing found.</p>
        ) : (
          <div className="req-grid">{results.map(card)}</div>
        )
      ) : (
        discover?.sections.map((section) => (
          <Row key={section.title} title={section.title}>
            {section.items.map(card)}
          </Row>
        ))
      )}

      {selected && (
        <RequestDetail item={selected} onClose={() => setSelected(null)} onRequested={loadMine} />
      )}
    </div>
  )
}
