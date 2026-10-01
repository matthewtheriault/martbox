import type { CastMember, CrewMember } from '../../../shared/types'
import { tmdbImageUrl } from '../lib/media'

interface CastCrewProps {
  cast: CastMember[]
  crew: CrewMember[]
  trailerKey: string | null
}

export default function CastCrew({ cast, crew, trailerKey }: CastCrewProps): JSX.Element | null {
  if (cast.length === 0 && crew.length === 0 && !trailerKey) return null

  const crewByJob = new Map<string, string[]>()
  for (const c of crew) {
    crewByJob.set(c.job, [...(crewByJob.get(c.job) ?? []), c.name])
  }

  return (
    <div className="cast-crew">
      <div className="cast-crew-header">
        {[...crewByJob.entries()].map(([job, names]) => (
          <span key={job} className="cast-crew-line">
            <strong>{job}:</strong> {names.join(', ')}
          </span>
        ))}
        {trailerKey && (
          <button
            className="btn-secondary"
            onClick={() =>
              window.api.system.openExternal(`https://www.youtube.com/watch?v=${trailerKey}`)
            }
          >
            Watch Trailer
          </button>
        )}
      </div>
      {cast.length > 0 && (
        <div className="cast-list">
          {cast.map((c, i) => (
            <div className="cast-member" key={i}>
              <div className="cast-member-photo">
                {c.profilePath ? (
                  <img src={tmdbImageUrl(c.profilePath)} alt={c.name} loading="lazy" />
                ) : (
                  <div className="cast-member-placeholder">{c.name.charAt(0)}</div>
                )}
              </div>
              <div className="cast-member-name">{c.name}</div>
              {c.character && <div className="cast-member-character">{c.character}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
