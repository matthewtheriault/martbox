import { useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Hls from 'hls.js'
import { usePort } from '../lib/PortContext'

export default function LiveChannelPlayer(): JSX.Element | null {
  const { channelId } = useParams<{ channelId: string }>()
  const port = usePort()
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !port || !channelId) return

    const src = `http://127.0.0.1:${port}/live/${channelId}`
    let hls: Hls | null = null

    if (Hls.isSupported()) {
      hls = new Hls()
      hls.loadSource(src)
      hls.attachMedia(video)
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src
    }

    return () => hls?.destroy()
  }, [port, channelId])

  if (!port || !channelId) return null

  return (
    <div className="player-page">
      <button className="player-back" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <video ref={videoRef} className="player-video" controls autoPlay />
    </div>
  )
}
