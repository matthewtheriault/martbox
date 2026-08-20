import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Hls from 'hls.js'
import type { IptvChannel } from '../../../shared/types'
import { usePort } from '../lib/PortContext'
import { formatClockTime } from '../lib/media'

export default function LiveChannelPlayer(): JSX.Element | null {
  const { channelId } = useParams<{ channelId: string }>()
  const port = usePort()
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [channel, setChannel] = useState<IptvChannel | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!channelId) return
    window.api.iptv
      .list()
      .then((channels) => setChannel(channels.find((c) => c.id === Number(channelId)) ?? null))
  }, [channelId])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !port || !channelId) return

    setError(null)
    const src = `http://127.0.0.1:${port}/live/${channelId}`
    let hls: Hls | null = null
    let recovered = false

    if (Hls.isSupported()) {
      hls = new Hls()
      // Dead/geo-blocked/hotlink-protected sources are common in public IPTV
      // lists — without this, a channel that can't actually play just leaves
      // the video element black and frozen forever, indistinguishable from
      // the app hanging. One recovery attempt for transient network/media
      // errors (hls.js's own recommended pattern), then a clear message.
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        if (!recovered && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          recovered = true
          hls?.startLoad()
          return
        }
        if (!recovered && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          recovered = true
          hls?.recoverMediaError()
          return
        }
        setError('This channel is unavailable right now.')
        hls?.destroy()
      })
      hls.loadSource(src)
      hls.attachMedia(video)
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src
      video.onerror = () => setError('This channel is unavailable right now.')
    }

    return () => hls?.destroy()
  }, [port, channelId])

  if (!port || !channelId) return null

  return (
    <div className="player-page">
      <button className="player-back" onClick={() => navigate(-1)}>
        ← Back
      </button>
      {error ? (
        <div className="player-error">
          <p>{error}</p>
          <button className="btn-secondary" onClick={() => navigate(-1)}>
            Back to Live TV
          </button>
        </div>
      ) : (
        <video ref={videoRef} className="player-video" controls autoPlay />
      )}
      {channel && (channel.name || channel.nowPlayingTitle) && (
        <div className="player-transcode-controls">
          <span>{channel.name}</span>
          {channel.nowPlayingTitle && (
            <span className="live-now-line">
              <span className="live-dot" />
              {channel.nowPlayingTitle}
            </span>
          )}
          {channel.nextProgrammeTitle && (
            <span className="live-next-line">
              Next: {channel.nextProgrammeTitle}
              {channel.nextProgrammeStartsAt && ` · ${formatClockTime(channel.nextProgrammeStartsAt)}`}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
