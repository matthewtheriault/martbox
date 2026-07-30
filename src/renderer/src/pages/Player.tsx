import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { MediaType } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { streamUrl, formatTime } from '../lib/media'

interface PlaybackTarget {
  title: string
  totalDurationSeconds: number
  startSeconds: number
}

export default function Player(): JSX.Element | null {
  const { mediaType, id } = useParams<{ mediaType: MediaType; id: string }>()
  const port = usePort()
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [target, setTarget] = useState<PlaybackTarget | null>(null)
  const [directPlay, setDirectPlay] = useState(true)
  const [offset, setOffset] = useState(0)

  const mediaId = Number(id)

  useEffect(() => {
    if (!mediaType || !id) return

    async function load(): Promise<void> {
      const progress = await window.api.progress.get(mediaType as MediaType, mediaId)
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
      }

      const probeRes = await fetch(`http://127.0.0.1:${port}/probe/${mediaType}/${mediaId}`)
      const probe = await probeRes.json()

      setDirectPlay(!!probe?.directPlay)
      setOffset(probe?.directPlay ? 0 : startSeconds)
      setTarget({ title, totalDurationSeconds, startSeconds })
    }

    load()
  }, [mediaType, id, port])

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
        window.api.progress.save(mediaType as MediaType, mediaId, absolutePosition, duration)
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [mediaType, mediaId, target, offset])

  const seekBy = (deltaSeconds: number): void => {
    const video = videoRef.current
    if (!video || !target) return
    const currentAbsolute = offset + video.currentTime
    const newAbsolute = Math.max(0, currentAbsolute + deltaSeconds)
    if (directPlay) {
      video.currentTime = newAbsolute
    } else {
      setOffset(newAbsolute)
    }
  }

  const handleEnded = (): void => {
    if (!mediaType || !target) return
    const duration = target.totalDurationSeconds || offset
    window.api.progress.save(mediaType as MediaType, mediaId, duration, duration)
  }

  const handlePause = (): void => {
    const video = videoRef.current
    if (!video || !mediaType || !target) return
    const absolutePosition = offset + video.currentTime
    const duration = target.totalDurationSeconds || video.duration || absolutePosition
    if (absolutePosition > 0) {
      window.api.progress.save(mediaType as MediaType, mediaId, absolutePosition, duration)
    }
  }

  if (!mediaType || !target || !port) return null

  const src = streamUrl(mediaType as MediaType, mediaId, port, directPlay ? undefined : offset)

  return (
    <div className="player-page">
      <button className="player-back" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <video
        key={src}
        ref={videoRef}
        className="player-video"
        src={src}
        controls
        autoPlay
        onEnded={handleEnded}
        onPause={handlePause}
      />
      {!directPlay && (
        <div className="player-transcode-controls">
          <span>Transcoding — {target.title}</span>
          <button onClick={() => seekBy(-30)}>-30s</button>
          <button onClick={() => seekBy(-10)}>-10s</button>
          <button onClick={() => seekBy(10)}>+10s</button>
          <button onClick={() => seekBy(30)}>+30s</button>
          {target.totalDurationSeconds > 0 && (
            <span>
              {formatTime(offset)} / {formatTime(target.totalDurationSeconds)}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
