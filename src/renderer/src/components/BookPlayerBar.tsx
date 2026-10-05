import { useEffect, useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { bookPlayer, SKIP_BACK, SKIP_FORWARD, SPEEDS, useBookPlayer } from '../lib/bookPlayer'
import { useAudioFocus } from '../lib/audioFocus'
import { useProfile } from '../lib/ProfileContext'
import { formatTime } from '../lib/media'

const SLEEP_CHOICES: { label: string; value: number | 'chapter' }[] = [
  { label: '15 minutes', value: 15 },
  { label: '30 minutes', value: 30 },
  { label: '45 minutes', value: 45 },
  { label: '1 hour', value: 60 },
  { label: 'End of chapter', value: 'chapter' }
]

function speedLabel(speed: number): string {
  return `${speed.toFixed(2).replace(/0$/, '').replace(/\.0$/, '')}×`
}

// The audiobook along the bottom of the app while one is open (and was
// used more recently than music).
export default function BookPlayerBar(): JSX.Element | null {
  const book = useBookPlayer()
  const focus = useAudioFocus()
  const navigate = useNavigate()
  const { activeProfile, profilePin } = useProfile()
  const [menu, setMenu] = useState<'speed' | 'sleep' | null>(null)
  const [, tick] = useState(0)
  useEffect(() => bookPlayer.setProfile(activeProfile.id, profilePin), [activeProfile.id, profilePin])
  // The sleep timer's countdown.
  useEffect(() => {
    if (book.sleep?.kind !== 'minutes') return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [book.sleep])

  const b = book.book
  if (!b || focus === 'music') return null
  const at = bookPlayer.chapterAt(book.positionSeconds)
  const chapter = at?.chapter
  const chapterLength = chapter ? chapter.end - chapter.start : b.durationSeconds
  const inChapter = chapter ? book.positionSeconds - chapter.start : book.positionSeconds
  const fraction = chapterLength > 0 ? Math.min(1, Math.max(0, inChapter / chapterLength)) : 0
  const left = (b.durationSeconds - book.positionSeconds) / book.speed

  const seek = (e: MouseEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const start = chapter?.start ?? 0
    void bookPlayer.seek(start + ((e.clientX - rect.left) / rect.width) * chapterLength)
  }
  const sleepLabel =
    book.sleep?.kind === 'minutes'
      ? formatTime(Math.max(0, (book.sleep.endsAt - Date.now()) / 1000))
      : book.sleep?.kind === 'chapter'
        ? 'Chapter end'
        : null

  return (
    <div className="now-playing book-playing">
      <div className="now-playing-progress" onClick={seek} title="This chapter">
        <div style={{ width: `${fraction * 100}%` }} />
      </div>
      <button className="now-playing-track" onClick={() => navigate(`/audiobooks/${b.id}`)}>
        <span className="now-playing-cover">
          {b.hasCover ? <img src={bookPlayer.coverUrl(b.id)} alt="" /> : <span>📖</span>}
        </span>
        <span className="now-playing-text">
          <span className="now-playing-title">{b.title}</span>
          <span className="now-playing-sub">{chapter ? chapter.title : b.author}</span>
        </span>
      </button>

      <div className="now-playing-controls">
        <button className="np-btn" title="Previous chapter" onClick={() => bookPlayer.previousChapter()}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M6 5h2v14H6zM20 5v14L9 12z" />
          </svg>
        </button>
        <button className="np-btn np-skip" title={`Back ${SKIP_BACK} seconds`} onClick={() => bookPlayer.skip(-SKIP_BACK)}>
          −{SKIP_BACK}
        </button>
        <button className="np-btn np-play" title={book.playing ? 'Pause' : 'Play'} onClick={() => void bookPlayer.toggle()}>
          {book.loading ? (
            <span className="np-spinner" />
          ) : book.playing ? (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
              <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <button className="np-btn np-skip" title={`Forward ${SKIP_FORWARD} seconds`} onClick={() => bookPlayer.skip(SKIP_FORWARD)}>
          +{SKIP_FORWARD}
        </button>
        <button className="np-btn" title="Next chapter" onClick={() => bookPlayer.nextChapter()}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M16 5h2v14h-2zM4 5v14l11-7z" />
          </svg>
        </button>
      </div>

      <div className="now-playing-right">
        <span className="now-playing-time" title={`${formatTime(left)} left in the book at this speed`}>
          {formatTime(inChapter)} / {formatTime(chapterLength)}
        </span>
        <div className="add-collection book-menu">
          <button className="np-btn np-text" title="Playback speed" onClick={() => setMenu(menu === 'speed' ? null : 'speed')}>
            {speedLabel(book.speed)}
          </button>
          {menu === 'speed' && (
            <div className="add-collection-menu book-menu-up">
              {SPEEDS.map((s) => (
                <button key={s} onClick={() => (bookPlayer.setSpeed(s), setMenu(null))}>
                  <span>{speedLabel(s)}</span>
                  {s === book.speed && <span className="check">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="add-collection book-menu">
          <button className={book.sleep ? 'np-btn np-text active' : 'np-btn np-text'} title="Sleep timer" onClick={() => setMenu(menu === 'sleep' ? null : 'sleep')}>
            {sleepLabel ?? 'Sleep'}
          </button>
          {menu === 'sleep' && (
            <div className="add-collection-menu book-menu-up">
              {SLEEP_CHOICES.map((c) => (
                <button key={c.label} onClick={() => (bookPlayer.setSleep(c.value), setMenu(null))}>
                  {c.label}
                </button>
              ))}
              {book.sleep && <button onClick={() => (bookPlayer.setSleep(null), setMenu(null))}>Turn Off</button>}
            </div>
          )}
        </div>
      </div>
      {book.error && <span className="now-playing-error">{book.error}</span>}
    </div>
  )
}
