import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Episode, MediaType } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { useProfile } from '../lib/ProfileContext'
import { streamUrl, formatTime } from '../lib/media'

interface PlaybackTarget {
  title: string
  totalDurationSeconds: number
  startSeconds: number
}

interface SubtitleTrackInfo {
  index: number
  label: string
}

const UP_NEXT_SECONDS = 10
const CONTROLS_HIDE_MS = 3000

export default function Player(): JSX.Element | null {
  const { mediaType, id } = useParams<{ mediaType: MediaType; id: string }>()
  const port = usePort()
  const { activeProfile, profilePin } = useProfile()
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [target, setTarget] = useState<PlaybackTarget | null>(null)
  const [directPlay, setDirectPlay] = useState(true)
  const [offset, setOffset] = useState(0)
  const [nextEpisode, setNextEpisode] = useState<Episode | null>(null)

  const [paused, setPaused] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [videoDuration, setVideoDuration] = useState(0)
  const [bufferedFraction, setBufferedFraction] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [upNextCountdown, setUpNextCountdown] = useState<number | null>(null)
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrackInfo[]>([])
  const [selectedSubtitle, setSelectedSubtitle] = useState<number | null>(null)
  const [subtitleMenuOpen, setSubtitleMenuOpen] = useState(false)

  const mediaId = Number(id)
  // The video element remounts (via key={src} below) whenever this changes
  // — direct play keeps a stable src, but a transcode-mode seek re-requests
  // the stream from a new offset, which is a brand new DOM node. Depending
  // on `src` (not just `target`) in the effects below is what makes their
  // listeners follow the video element across that remount instead of
  // staying attached to the one that just got torn down.
  const src =
    mediaType && port ? streamUrl(mediaType as MediaType, mediaId, port, directPlay ? undefined : offset) : ''

  useEffect(() => {
    if (!mediaType || !id) return

    async function load(): Promise<void> {
      const progress = await window.api.progress.get(
        activeProfile.id,
        mediaType as MediaType,
        mediaId,
        profilePin
      )
      const startSeconds = progress && !progress.watched ? progress.positionSeconds : 0

      let title = ''
      let totalDurationSeconds = progress?.durationSeconds ?? 0

      if (mediaType === 'movie') {
        const movie = await window.api.movies.get(mediaId)
        title = movie?.title ?? ''
        if (!totalDurationSeconds && movie?.runtimeMinutes) totalDurationSeconds = movie.runtimeMinutes * 60
      } else {
        const episode = await window.api.episodes.get(mediaId)
        title = episode?.title ?? ''
        if (!totalDurationSeconds && episode?.durationSeconds) totalDurationSeconds = episode.durationSeconds
        if (episode) {
          // The chronologically-next episode, not "next unwatched" — up next
          // should always mean "what comes after this one," regardless of
          // whether the viewer happens to have watched other episodes out of
          // order.
          const all = await window.api.shows.episodes(episode.showId)
          const index = all.findIndex((e) => e.id === episode.id)
          setNextEpisode(index >= 0 ? (all[index + 1] ?? null) : null)
        }
      }

      const probeRes = await fetch(`http://127.0.0.1:${port}/probe/${mediaType}/${mediaId}`)
      const probe = await probeRes.json()

      const subsRes = await fetch(`http://127.0.0.1:${port}/subtitles/${mediaType}/${mediaId}`)
      setSubtitleTracks(await subsRes.json().catch(() => []))
      setSelectedSubtitle(null)

      setDirectPlay(!!probe?.directPlay)
      setOffset(probe?.directPlay ? 0 : startSeconds)
      setTarget({ title, totalDurationSeconds, startSeconds })
    }

    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaType, id, port, activeProfile.id])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !target) return

    if (directPlay && target.startSeconds > 0) {
      const setStart = (): void => {
        video.currentTime = target.startSeconds
      }
      video.addEventListener('loadedmetadata', setStart, { once: true })
      return () => video.removeEventListener('loadedmetadata', setStart)
    }
    return undefined
  }, [target, directPlay])

  useEffect(() => {
    if (!mediaType || !target) return
    const interval = setInterval(() => {
      const video = videoRef.current
      if (!video) return
      const absolutePosition = offset + video.currentTime
      const duration = target.totalDurationSeconds || video.duration || absolutePosition
      if (absolutePosition > 0) {
        window.api.progress.save(
          activeProfile.id,
          mediaType as MediaType,
          mediaId,
          absolutePosition,
          duration,
          profilePin
        )
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [mediaType, mediaId, target, offset, activeProfile.id, profilePin])

  // Video element event -> control-bar state wiring.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const onTimeUpdate = (): void => setCurrentTime(video.currentTime)
    const onDurationChange = (): void => setVideoDuration(video.duration || 0)
    const onPlay = (): void => setPaused(false)
    const onPause = (): void => setPaused(true)
    const onVolumeChange = (): void => {
      setVolume(video.volume)
      setMuted(video.muted)
    }
    const onProgress = (): void => {
      if (video.buffered.length === 0 || !video.duration) return
      setBufferedFraction(video.buffered.end(video.buffered.length - 1) / video.duration)
    }

    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('durationchange', onDurationChange)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('volumechange', onVolumeChange)
    video.addEventListener('progress', onProgress)
    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('durationchange', onDurationChange)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('volumechange', onVolumeChange)
      video.removeEventListener('progress', onProgress)
    }
  }, [target, src])

  useEffect(() => {
    const onFullscreenChange = (): void => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  // <track> elements only declare availability — actually turning one on
  // (and every other one off) is done imperatively via TextTrack.mode,
  // since there's no custom-controls-friendly HTML attribute for "the
  // active one changed after the user picked from a menu."
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    for (let i = 0; i < video.textTracks.length; i++) {
      video.textTracks[i].mode = i === selectedSubtitle ? 'showing' : 'disabled'
    }
  }, [selectedSubtitle, subtitleTracks, target, src])

  // Auto-hide the control bar during playback; any mouse movement resets
  // the timer. Left visible whenever paused, since there's nothing to hide
  // it from.
  useEffect(() => {
    if (paused) {
      setControlsVisible(true)
      return undefined
    }
    let timer = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_MS)
    const onMove = (): void => {
      setControlsVisible(true)
      clearTimeout(timer)
      timer = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_MS)
    }
    const el = containerRef.current
    el?.addEventListener('mousemove', onMove)
    return () => {
      clearTimeout(timer)
      el?.removeEventListener('mousemove', onMove)
    }
  }, [paused])

  const seekTo = useCallback(
    (absoluteSeconds: number): void => {
      const video = videoRef.current
      if (!video || !target) return
      const clamped = Math.max(0, absoluteSeconds)
      if (directPlay) {
        video.currentTime = clamped
      } else {
        setOffset(clamped)
      }
    },
    [directPlay, target]
  )

  const seekBy = (deltaSeconds: number): void => {
    const video = videoRef.current
    if (!video || !target) return
    const currentAbsolute = offset + video.currentTime
    seekTo(currentAbsolute + deltaSeconds)
  }

  const togglePlay = (): void => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) video.play()
    else video.pause()
  }

  const toggleMute = (): void => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
  }

  const changeVolume = (v: number): void => {
    const video = videoRef.current
    if (!video) return
    video.volume = Math.min(1, Math.max(0, v))
    if (video.volume > 0) video.muted = false
  }

  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      containerRef.current?.requestFullscreen()
    }
  }

  const absoluteDuration = target?.totalDurationSeconds || (directPlay ? videoDuration : offset + videoDuration)
  const absoluteCurrent = directPlay ? currentTime : offset + currentTime

  const handleSeekBarClick = (e: MouseEvent<HTMLDivElement>): void => {
    if (!absoluteDuration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    seekTo(fraction * absoluteDuration)
  }

  const goToNextEpisode = useCallback((): void => {
    if (nextEpisode) navigate(`/play/episode/${nextEpisode.id}`)
  }, [nextEpisode, navigate])

  const handleEnded = (): void => {
    if (!mediaType || !target) return
    const duration = target.totalDurationSeconds || offset
    window.api.progress.save(activeProfile.id, mediaType as MediaType, mediaId, duration, duration, profilePin)
    if (nextEpisode) setUpNextCountdown(UP_NEXT_SECONDS)
  }

  useEffect(() => {
    if (upNextCountdown === null) return
    if (upNextCountdown <= 0) {
      goToNextEpisode()
      return
    }
    const timer = setTimeout(() => setUpNextCountdown((v) => (v ?? 0) - 1), 1000)
    return () => clearTimeout(timer)
  }, [upNextCountdown, goToNextEpisode])

  const handlePause = (): void => {
    const video = videoRef.current
    if (!video || !mediaType || !target) return
    const absolutePosition = offset + video.currentTime
    const duration = target.totalDurationSeconds || video.duration || absolutePosition
    if (absolutePosition > 0) {
      window.api.progress.save(
        activeProfile.id,
        mediaType as MediaType,
        mediaId,
        absolutePosition,
        duration,
        profilePin
      )
    }
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (upNextCountdown !== null) return
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowLeft':
          e.preventDefault()
          seekBy(-10)
          break
        case 'ArrowRight':
          e.preventDefault()
          seekBy(10)
          break
        case 'ArrowUp':
          e.preventDefault()
          changeVolume(volume + 0.1)
          break
        case 'ArrowDown':
          e.preventDefault()
          changeVolume(volume - 0.1)
          break
        case 'm':
          toggleMute()
          break
        case 'f':
          toggleFullscreen()
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, offset, target, directPlay, upNextCountdown])

  if (!mediaType || !target || !port) return null

  return (
    <div className={fullscreen ? 'player-page player-page-fullscreen' : 'player-page'} ref={containerRef}>
      {controlsVisible && (
        <button className="player-back" onClick={() => navigate(-1)}>
          ← Back
        </button>
      )}
      <video
        key={src}
        ref={videoRef}
        className="player-video"
        src={src}
        autoPlay
        onEnded={handleEnded}
        onPause={handlePause}
        onClick={togglePlay}
      >
        {subtitleTracks.map((t) => (
          <track
            key={t.index}
            kind="subtitles"
            label={t.label}
            src={`http://127.0.0.1:${port}/subtitles/${mediaType}/${mediaId}/${t.index}`}
          />
        ))}
      </video>

      {upNextCountdown !== null && nextEpisode && (
        <div className="player-up-next">
          <p>Up Next</p>
          <p className="player-up-next-title">{nextEpisode.title}</p>
          <div className="player-up-next-actions">
            <button className="btn-primary" onClick={goToNextEpisode}>
              Play Now ({upNextCountdown})
            </button>
            <button className="btn-secondary" onClick={() => setUpNextCountdown(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className={controlsVisible ? 'player-controls' : 'player-controls player-controls-hidden'}>
        <div className="player-seekbar" onClick={handleSeekBarClick}>
          <div className="player-seekbar-buffered" style={{ width: `${bufferedFraction * 100}%` }} />
          <div
            className="player-seekbar-fill"
            style={{ width: `${absoluteDuration ? (absoluteCurrent / absoluteDuration) * 100 : 0}%` }}
          />
        </div>
        <div className="player-controls-row">
          <button className="player-control-btn" onClick={togglePlay}>
            {paused ? (
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <path d="M8 5v14l11-7z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
              </svg>
            )}
          </button>
          <button className="player-control-btn" onClick={() => seekBy(-10)} title="Back 10s">
            -10s
          </button>
          <button className="player-control-btn" onClick={() => seekBy(10)} title="Forward 10s">
            +10s
          </button>
          <span className="player-time">
            {formatTime(absoluteCurrent)} / {absoluteDuration ? formatTime(absoluteDuration) : '--:--'}
          </span>
          {!directPlay && <span className="player-transcode-badge">Transcoding</span>}
          <span className="player-title-inline">{target.title}</span>
          <div className="player-volume">
            <button className="player-control-btn" onClick={toggleMute}>
              {muted || volume === 0 ? (
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                  <path d="M16.5 12A4.5 4.5 0 0 0 14 8v1.79l2.48 2.48c.01-.09.02-.18.02-.27zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.94 8.94 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                </svg>
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => changeVolume(parseFloat(e.target.value))}
            />
          </div>
          {subtitleTracks.length > 0 && (
            <div className="player-subtitle-menu">
              <button
                className={
                  selectedSubtitle !== null ? 'player-control-btn player-control-btn-active' : 'player-control-btn'
                }
                onClick={() => setSubtitleMenuOpen((v) => !v)}
                title="Subtitles"
              >
                CC
              </button>
              {subtitleMenuOpen && (
                <div className="player-subtitle-options">
                  <button
                    className={selectedSubtitle === null ? 'active' : ''}
                    onClick={() => {
                      setSelectedSubtitle(null)
                      setSubtitleMenuOpen(false)
                    }}
                  >
                    Off
                  </button>
                  {subtitleTracks.map((t) => (
                    <button
                      key={t.index}
                      className={selectedSubtitle === t.index ? 'active' : ''}
                      onClick={() => {
                        setSelectedSubtitle(t.index)
                        setSubtitleMenuOpen(false)
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button className="player-control-btn" onClick={toggleFullscreen} title="Fullscreen">
            {fullscreen ? (
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
