import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Channel, ChannelNow } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { useProfile } from '../lib/ProfileContext'
import { streamUrl } from '../lib/media'

// Watching a Live Channel: joins whatever is on right now, at the right
// point, and moves on to the next program by itself. ↑/↓ change channel,
// Esc goes back to the guide. After STILL_WATCHING_MS with no keyboard or
// mouse input it pauses and asks, so a channel left on doesn't stream all
// day to nobody.

const STILL_WATCHING_MS = 3 * 60 * 60 * 1000
const BANNER_MS = 5000

function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export default function LivePlayer(): JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const port = usePort()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [now, setNow] = useState<ChannelNow | null>(null)
  const [src, setSrc] = useState('')
  const [directOffset, setDirectOffset] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [bannerUntil, setBannerUntil] = useState(Date.now() + BANNER_MS)
  const [channels, setChannels] = useState<Channel[]>([])
  const [askStillWatching, setAskStillWatching] = useState(false)
  const lastInput = useRef(Date.now())
  const { activeProfile } = useProfile()
  const channelId = Number(id)

  // Tune in: what's on now, from the right point.
  const tune = useCallback(async () => {
    try {
      const current = await window.api.channels.now(channelId)
      setNow(current)
      setError(null)
      setBannerUntil(Date.now() + BANNER_MS)
      const { mediaType, mediaId } = current.program
      const probe = await fetch(`http://127.0.0.1:${port}/probe/${mediaType}/${mediaId}`)
        .then((r) => r.json())
        .catch(() => null)
      if (probe?.directPlay) {
        // A seekable file: load it whole and jump to the point.
        setDirectOffset(current.offsetSeconds)
        setSrc(streamUrl(mediaType, mediaId, port))
      } else {
        // A converted stream starts at the point itself.
        setDirectOffset(null)
        setSrc(streamUrl(mediaType, mediaId, port, Math.floor(current.offsetSeconds)))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [channelId, port])

  useEffect(() => {
    if (port) void tune()
  }, [tune, port])

  useEffect(() => {
    window.api.channels
      .guide(Date.now(), Date.now() + 60_000)
      .then((g) => setChannels(g.channels.map((c) => c.channel)))
      .catch(() => {})
  }, [])

  // The schedule, not the file, decides when a program ends.
  useEffect(() => {
    if (!now) return
    const wait = Math.max(1000, now.program.end - Date.now())
    const timer = setTimeout(() => void tune(), wait)
    return () => clearTimeout(timer)
  }, [now, tune])

  useEffect(() => {
    const video = videoRef.current
    if (!video || directOffset === null) return
    const seek = (): void => {
      video.currentTime = directOffset
    }
    video.addEventListener('loadedmetadata', seek, { once: true })
    return () => video.removeEventListener('loadedmetadata', seek)
  }, [src, directOffset])

  const zap = useCallback(
    (step: number) => {
      if (channels.length === 0) return
      const index = channels.findIndex((c) => c.id === channelId)
      const next = channels[(index + step + channels.length) % channels.length]
      navigate(`/live/${next.id}`, { replace: true })
    },
    [channels, channelId, navigate]
  )

  useEffect(() => {
    const onInput = (): void => {
      lastInput.current = Date.now()
    }
    const onKey = (e: KeyboardEvent): void => {
      onInput()
      if (e.key === 'ArrowUp') zap(1)
      else if (e.key === 'ArrowDown') zap(-1)
      else if (e.key === 'Escape') navigate('/live')
      else if (e.key === 'i') setBannerUntil(Date.now() + BANNER_MS)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousemove', onInput)
    window.addEventListener('mousedown', onInput)
    const timer = setInterval(() => {
      if (Date.now() - lastInput.current > STILL_WATCHING_MS) {
        videoRef.current?.pause()
        setAskStillWatching(true)
      }
    }, 60_000)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousemove', onInput)
      window.removeEventListener('mousedown', onInput)
      clearInterval(timer)
    }
  }, [zap, navigate])

  // Tells the server's dashboard what's on and that it's a channel.
  useEffect(() => {
    if (!now) return
    const beat = (): void => {
      const video = videoRef.current
      if (!video) return
      const position =
        directOffset !== null ? video.currentTime : now.offsetSeconds + video.currentTime
      const state = video.paused ? 'paused' : video.readyState < 3 ? 'buffering' : 'playing'
      window.api.dashboard
        .heartbeat(
          activeProfile.id,
          now.program.mediaType,
          now.program.mediaId,
          position,
          state,
          now.channel.id
        )
        .catch(() => {})
    }
    beat()
    const timer = setInterval(beat, 10_000)
    return () => clearInterval(timer)
  }, [now, directOffset, activeProfile.id])

  // Hide the banner after a few seconds; mouse movement brings it back.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const showBanner = Date.now() < bannerUntil

  const program = now?.program
  const remaining = program ? Math.max(0, Math.round((program.end - Date.now()) / 60_000)) : 0

  return (
    <div className="live-player" onMouseMove={() => setBannerUntil(Date.now() + BANNER_MS)}>
      {src && (
        <video
          key={src}
          ref={videoRef}
          className="live-player-video"
          src={src}
          autoPlay
          onEnded={() => void tune()}
        />
      )}
      {error && <div className="live-player-error">{error}</div>}

      {now && program && showBanner && (
        <div className="live-banner">
          <div className="live-banner-channel">
            <span className="live-number">{now.channel.number}</span>
            {now.channel.name}
          </div>
          <div className="live-banner-title">{program.title}</div>
          <div className="live-banner-sub">
            {program.subtitle} · {clock(program.start)}–{clock(program.end)} · {remaining} min left
          </div>
          {now.next && (
            <div className="live-banner-next">
              Next: {now.next.title}
              {now.next.mediaType === 'episode' ? ` · ${now.next.subtitle}` : ''} at{' '}
              {clock(now.next.start)}
            </div>
          )}
          <div className="live-banner-keys">↑ ↓ change channel · Esc guide</div>
        </div>
      )}

      <button
        className="live-player-back"
        onClick={() => navigate('/live')}
        aria-label="Back to guide"
      >
        ‹ Guide
      </button>

      {askStillWatching && (
        <div className="live-still">
          <div className="live-still-box">
            <h2>Still watching?</h2>
            <p>{now?.channel.name} paused after a while with nothing pressed.</p>
            <button
              className="btn-primary"
              onClick={() => {
                lastInput.current = Date.now()
                setAskStillWatching(false)
                // Back to live, not where it paused.
                void tune()
              }}
            >
              Keep watching
            </button>
            <button className="btn-secondary" onClick={() => navigate('/live')}>
              Back to guide
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
