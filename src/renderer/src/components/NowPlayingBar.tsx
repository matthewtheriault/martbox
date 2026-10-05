import { useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { musicPlayer } from '../lib/musicPlayer'
import { useMusic } from '../lib/useMusic'
import { formatTime } from '../lib/media'

// The music player along the bottom of the app while anything is queued.
export default function NowPlayingBar(): JSX.Element | null {
  const music = useMusic()
  const navigate = useNavigate()
  const [showQueue, setShowQueue] = useState(false)
  const track = music.queue[music.index]
  if (!track) return null
  const duration = musicPlayer.durationSeconds || track.durationSeconds
  const fraction = duration ? Math.min(1, music.positionSeconds / duration) : 0

  const seek = (e: MouseEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    musicPlayer.seek(((e.clientX - rect.left) / rect.width) * duration)
  }

  return (
    <>
      {showQueue && (
        <div className="music-queue">
          <div className="music-queue-head">
            <h2>Up Next</h2>
            <button className="link-button" onClick={() => setShowQueue(false)}>
              Close
            </button>
          </div>
          <ol>
            {music.queue.map((t, i) => (
              <li key={`${t.id}-${i}`}>
                <button className={i === music.index ? 'playing' : ''} onClick={() => musicPlayer.playAt(i)}>
                  <span className="music-queue-title">{t.title}</span>
                  <span className="music-queue-sub">{t.artist}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="now-playing">
        <div className="now-playing-progress" onClick={seek}>
          <div style={{ width: `${fraction * 100}%` }} />
        </div>
        <button className="now-playing-track" onClick={() => navigate(`/music/album/${track.albumId}`)}>
          <span className="now-playing-cover">
            {track.hasCover ? <img src={musicPlayer.coverUrl(track.albumId)} alt="" /> : <span>♪</span>}
          </span>
          <span className="now-playing-text">
            <span className="now-playing-title">{track.title}</span>
            <span className="now-playing-sub">
              {track.artist} · {track.album}
            </span>
          </span>
        </button>

        <div className="now-playing-controls">
          <button
            className={music.shuffle ? 'np-btn active' : 'np-btn'}
            title="Shuffle"
            onClick={() => musicPlayer.setShuffle(!music.shuffle)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
            </svg>
          </button>
          <button className="np-btn" title="Previous" onClick={() => musicPlayer.skipPrevious()}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M6 5h2v14H6zM20 5v14L9 12z" />
            </svg>
          </button>
          <button className="np-btn np-play" title={music.playing ? 'Pause' : 'Play'} onClick={() => void musicPlayer.toggle()}>
            {music.loading ? (
              <span className="np-spinner" />
            ) : music.playing ? (
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
          <button className="np-btn" title="Next" onClick={() => musicPlayer.skipNext()}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M16 5h2v14h-2zM4 5v14l11-7z" />
            </svg>
          </button>
          <button
            className={music.repeat !== 'off' ? 'np-btn active' : 'np-btn'}
            title={music.repeat === 'one' ? 'Repeat one' : music.repeat === 'all' ? 'Repeat all' : 'Repeat'}
            onClick={() => musicPlayer.cycleRepeat()}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
            {music.repeat === 'one' && <span className="np-one">1</span>}
          </button>
        </div>

        <div className="now-playing-right">
          <span className="now-playing-time">
            {formatTime(music.positionSeconds)} / {formatTime(duration)}
          </span>
          {(music.format === 'alac' || (music.format === 'original' && track.lossless)) && <span className="music-badge">Lossless</span>}
          <input
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={music.volume}
            onChange={(e) => musicPlayer.setVolume(parseFloat(e.target.value))}
            aria-label="Volume"
          />
          <button className={showQueue ? 'np-btn active' : 'np-btn'} title="Up Next" onClick={() => setShowQueue((v) => !v)}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 6h13M3 12h13M3 18h9M19 14v7M16 18l3 3 3-3" />
            </svg>
          </button>
        </div>
        {music.error && <span className="now-playing-error">{music.error}</span>}
      </div>
    </>
  )
}
