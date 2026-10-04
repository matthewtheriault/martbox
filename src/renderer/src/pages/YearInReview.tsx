import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { YearInReview as Review, YearInReviewTitle } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { useProfile } from '../lib/ProfileContext'
import { imageUrl } from '../lib/media'
import Avatar from '../components/Avatar'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']

function hours(seconds: number): string {
  const h = seconds / 3600
  if (h >= 10) return `${Math.round(h).toLocaleString()} hours`
  if (h >= 1) return `${h.toFixed(1)} hours`
  return `${Math.max(1, Math.round(seconds / 60))} minutes`
}

function longDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

export default function YearInReview(): JSX.Element {
  const { activeProfile, profilePin } = useProfile()
  const [year, setYear] = useState<number | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    window.api
      .yearInReview(activeProfile.id, profilePin, year)
      .then(setReview)
      .catch((e) => setError((e as Error).message))
  }, [activeProfile.id, profilePin, year])

  if (error) {
    return (
      <div className="page">
        <h1 className="page-title">Year in Review</h1>
        <p className="settings-status-error">{error}</p>
      </div>
    )
  }
  if (!review) return <div className="page" />

  const years = review.years.includes(review.year) ? review.years : [review.year, ...review.years]
  const busiestMonth = review.monthSeconds.indexOf(Math.max(...review.monthSeconds))
  const favouriteDay = review.weekdaySeconds.indexOf(Math.max(...review.weekdaySeconds))
  const maxMonth = Math.max(1, ...review.monthSeconds)

  return (
    <div className="page yir">
      <header className="yir-hero">
        <Avatar profile={activeProfile} className="profile-avatar yir-avatar" />
        <div>
          <p className="yir-kicker">{activeProfile.name}’s</p>
          <h1 className="yir-title">
            <span className="yir-gradient">{review.year}</span> in MartBox
          </h1>
        </div>
        {years.length > 1 && (
          <div className="yir-years" role="tablist">
            {years.map((y) => (
              <button
                key={y}
                role="tab"
                aria-selected={y === review.year}
                className={y === review.year ? 'yir-year active' : 'yir-year'}
                onClick={() => setYear(y)}
              >
                {y}
              </button>
            ))}
          </div>
        )}
      </header>

      {review.totalSeconds === 0 ? (
        <p className="empty-state-inline">
          Nothing watched in {review.year} yet. Your year fills in as you watch.
        </p>
      ) : (
        <>
          <section className="yir-total">
            <span className="yir-big yir-gradient">{hours(review.totalSeconds)}</span>
            <span className="yir-total-label">
              of watching, across {review.daysWatched} {review.daysWatched === 1 ? 'day' : 'days'}
            </span>
          </section>

          <section className="yir-stats">
            <Stat value={review.moviesWatched} label={review.moviesWatched === 1 ? 'movie' : 'movies'} />
            <Stat value={review.episodesWatched} label={review.episodesWatched === 1 ? 'episode' : 'episodes'} />
            <Stat value={review.showsWatched} label={review.showsWatched === 1 ? 'show' : 'shows'} />
            <Stat value={review.longestStreak} label="days in a row, at best" />
          </section>

          {review.topShows.length > 0 && <TopList title="Your top shows" items={review.topShows} />}
          {review.topMovies.length > 0 && <TopList title="Your top movies" items={review.topMovies} />}

          <section className="yir-card">
            <h2>Month by month</h2>
            <div className="yir-months">
              {review.monthSeconds.map((s, i) => (
                <div key={i} className="yir-month" title={`${MONTHS[i]}: ${hours(s)}`}>
                  <div className="yir-month-track">
                    <div
                      className={i === busiestMonth ? 'yir-month-bar peak' : 'yir-month-bar'}
                      style={{ height: `${(s / maxMonth) * 100}%` }}
                    />
                  </div>
                  <span>{MONTHS[i]}</span>
                </div>
              ))}
            </div>
            <p className="yir-note">
              {new Date(2000, busiestMonth).toLocaleString(undefined, { month: 'long' })} was your biggest month, with {hours(review.monthSeconds[busiestMonth])}.
            </p>
          </section>

          <section className="yir-facts">
            <Fact title="Favourite day" value={WEEKDAYS[favouriteDay]} />
            {review.busiestDay && (
              <Fact
                title="Biggest day"
                value={longDate(review.busiestDay.day)}
                detail={hours(review.busiestDay.seconds)}
              />
            )}
            {review.topGenres.length > 0 && (
              <Fact
                title="Top genres"
                value={review.topGenres
                  .slice(0, 3)
                  .map((g) => g.name)
                  .join(', ')}
              />
            )}
            {review.firstTitle && (
              <Fact title="Where it started" value={review.firstTitle.title} detail={longDate(review.firstTitle.day)} />
            )}
            {review.finished > 0 && (
              <Fact title="Finished" value={`${review.finished} ${review.finished === 1 ? 'title' : 'movies and episodes'}`} />
            )}
          </section>
        </>
      )}
    </div>
  )
}

function Stat({ value, label }: { value: number; label: string }): JSX.Element {
  return (
    <div className="yir-stat">
      <span className="yir-stat-value">{value.toLocaleString()}</span>
      <span className="yir-stat-label">{label}</span>
    </div>
  )
}

function Fact({ title, value, detail }: { title: string; value: string; detail?: string }): JSX.Element {
  return (
    <div className="yir-fact">
      <span className="yir-fact-title">{title}</span>
      <span className="yir-fact-value">{value}</span>
      {detail && <span className="yir-fact-detail">{detail}</span>}
    </div>
  )
}

function TopList({ title, items }: { title: string; items: YearInReviewTitle[] }): JSX.Element {
  const port = usePort()
  const navigate = useNavigate()
  return (
    <section className="yir-card">
      <h2>{title}</h2>
      <ol className="yir-top">
        {items.map((item, i) => (
          <li key={`${item.mediaType}-${item.id}`}>
            <button
              className="yir-top-item"
              onClick={() => navigate(item.mediaType === 'movie' ? `/movie/${item.id}` : `/show/${item.id}`)}
            >
              <span className="yir-poster">
                {item.posterPath ? <img src={imageUrl(item.posterPath, port)} alt="" /> : null}
                <span className="yir-rank">{i + 1}</span>
              </span>
              <span className="yir-top-text">
                <span className="yir-top-title">{item.title}</span>
                <span className="yir-top-time">{hours(item.seconds)}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
