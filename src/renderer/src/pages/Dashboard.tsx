import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DashboardDevice, DashboardSnapshot, DashboardStream } from '../../../shared/types'
import { useProfile } from '../lib/ProfileContext'
import { usePort } from '../lib/PortContext'
import { formatTime, imageUrl } from '../lib/media'

// The host's live view (admin only): who's watching what right now and how
// the upload is coping. Data comes from src/main/dashboard.ts, refreshed
// every 2 seconds.

const REFRESH_MS = 2000

function formatMbps(mbps: number): string {
  if (mbps >= 100) return `${Math.round(mbps)} Mbps`
  if (mbps >= 0.1) return `${mbps.toFixed(1)} Mbps`
  return mbps > 0 ? '< 0.1 Mbps' : '0 Mbps'
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return bytes > 0 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : '—'
}

// SQLite datetime('now') is UTC without a zone marker.
function parseDbTime(value: string | null): number | null {
  if (!value) return null
  const t = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isFinite(t) ? t : null
}

function timeAgo(value: string | null): string {
  const t = parseDbTime(value)
  if (t === null) return 'never'
  const minutes = Math.round((Date.now() - t) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

function methodLabel(stream: DashboardStream): { text: string; tone: 'good' | 'warn' | 'plain' } {
  switch (stream.method) {
    case 'direct':
      return { text: 'Direct play', tone: 'good' }
    case 'remux':
      return { text: 'Direct stream', tone: 'good' }
    case 'transcode': {
      const size = /Converting to (\d+p)/.exec(stream.reason ?? '')?.[1]
      return { text: size ? `Converting · ${size}` : 'Converting', tone: 'warn' }
    }
    default:
      return { text: stream.deviceName === 'This PC' ? 'On this PC' : 'Playing', tone: 'plain' }
  }
}

function UploadChart({
  samples,
  capacity
}: {
  samples: { t: number; mbps: number }[]
  capacity: number | null
}): JSX.Element {
  const width = 640
  const height = 140
  const span = 5 * 60 * 1000
  const now = samples.length ? samples[samples.length - 1].t : Date.now()
  const peak = Math.max(1, ...samples.map((s) => s.mbps))
  // Scale to the busiest moment, with room above; the capacity line is
  // drawn only when it fits on the chart.
  const top = Math.max(peak * 1.25, 2)
  const x = (t: number): number => width - ((now - t) / span) * width
  const y = (mbps: number): number => height - (mbps / top) * (height - 8)
  const points = samples.map((s) => `${x(s.t).toFixed(1)},${y(s.mbps).toFixed(1)}`)
  const area =
    points.length > 1
      ? `M${points[0]} L${points.join(' L')} L${width},${height} ` +
        `L${x(samples[0].t).toFixed(1)},${height} Z`
      : ''
  return (
    <svg
      className="dash-chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Upload over the last 5 minutes"
    >
      <defs>
        <linearGradient id="dash-chart-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-2)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--accent-2)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1="0"
          x2={width}
          y1={height * f}
          y2={height * f}
          className="dash-chart-grid"
        />
      ))}
      {capacity !== null && capacity <= top && (
        <line x1="0" x2={width} y1={y(capacity)} y2={y(capacity)} className="dash-chart-capacity" />
      )}
      {area && <path d={area} fill="url(#dash-chart-fill)" />}
      {points.length > 1 && <polyline points={points.join(' ')} className="dash-chart-line" />}
    </svg>
  )
}

function StreamCard({
  stream,
  port,
  onStop
}: {
  stream: DashboardStream
  port: number
  onStop: (message: string) => Promise<void>
}): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState('')
  const method = methodLabel(stream)
  const fraction = stream.durationSeconds
    ? Math.min(1, stream.positionSeconds / stream.durationSeconds)
    : 0
  return (
    <div className="dash-stream">
      <div className="dash-stream-poster">
        {stream.posterPath && <img src={imageUrl(stream.posterPath, port)} alt="" />}
      </div>
      <div className="dash-stream-body">
        <div className="dash-stream-title">{stream.title}</div>
        {stream.subtitle && <div className="dash-stream-subtitle">{stream.subtitle}</div>}
        <div className="dash-stream-who">
          <span
            className="sidebar-profile-avatar activity-avatar"
            style={{ background: stream.profileAvatarId ?? undefined }}
          >
            {(stream.profileName || '?').charAt(0).toUpperCase()}
          </span>
          {stream.profileName || 'Unknown user'} · {stream.deviceName}
        </div>
        <div className="dash-progress">
          <div className="dash-progress-fill" style={{ width: `${fraction * 100}%` }} />
        </div>
        <div className="dash-stream-meta">
          <span className={`dash-state dash-state-${stream.state}`}>
            {stream.state === 'playing'
              ? 'Playing'
              : stream.state === 'paused'
                ? 'Paused'
                : 'Buffering'}
          </span>
          <span>
            {formatTime(stream.positionSeconds)}
            {stream.durationSeconds ? ` / ${formatTime(stream.durationSeconds)}` : ''}
          </span>
          {stream.deviceName !== 'This PC' && <span>{formatMbps(stream.mbps)}</span>}
        </div>
        <div className="dash-stream-method">
          <span className={`dash-badge dash-badge-${method.tone}`}>{method.text}</span>
          {stream.reason && (
            // The badge already says "Direct stream" / "Converting · 720p";
            // the reason line adds the why.
            <span className="dash-reason">{stream.reason.replace(/^[^:]*:\s*/, '')}</span>
          )}
        </div>
        {stream.recentStalls > 0 && (
          <div className="dash-warning">
            Buffered {stream.recentStalls}× in the last 5 minutes
          </div>
        )}
        {stream.deviceName !== 'This PC' &&
          (confirming ? (
            <div className="dash-stop-form">
              <input
                type="text"
                placeholder="Message for them (optional)"
                value={message}
                maxLength={200}
                onChange={(e) => setMessage(e.target.value)}
                autoFocus
              />
              <button className="btn-danger" onClick={() => onStop(message)}>
                Stop
              </button>
              <button className="btn-secondary" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button className="dash-stop" onClick={() => setConfirming(true)}>
              Stop stream
            </button>
          ))}
      </div>
    </div>
  )
}

function pathLabel(device: DashboardDevice): { text: string; tone: 'good' | 'warn' | 'plain' } {
  if (device.online === false) return { text: 'Offline', tone: 'plain' }
  switch (device.path) {
    case 'direct':
      return { text: 'Direct', tone: 'good' }
    case 'relayed':
      return { text: 'Relayed (slow)', tone: 'warn' }
    case 'idle':
      return { text: 'Online', tone: 'plain' }
    default:
      return { text: '—', tone: 'plain' }
  }
}

export default function Dashboard(): JSX.Element | null {
  const { activeProfile } = useProfile()
  const port = usePort()
  const navigate = useNavigate()
  const [data, setData] = useState<DashboardSnapshot | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [capacityDraft, setCapacityDraft] = useState<string | null>(null)

  useEffect(() => {
    if (!activeProfile.isAdmin) {
      navigate('/', { replace: true })
      return
    }
    let cancelled = false
    const load = (): void => {
      window.api.dashboard
        .snapshot(activeProfile.id)
        .then((snapshot) => {
          if (cancelled) return
          if (snapshot === null) setUnavailable(true)
          else setData(snapshot)
        })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [activeProfile.id, activeProfile.isAdmin])

  if (!activeProfile.isAdmin) return null

  if (unavailable) {
    return (
      <div className="page">
        <h1 className="page-title">Dashboard</h1>
        <p className="empty-state-inline">
          The dashboard is on the server — open MartBox on the server PC.
        </p>
      </div>
    )
  }
  if (!data) return <div className="page" />

  const { streams, network } = data
  const capacity = network.uploadCapacityMbps
  const saveCapacity = (): void => {
    if (capacityDraft === null) return
    const value = parseFloat(capacityDraft)
    window.api.dashboard
      .setUploadCapacity(activeProfile.id, Number.isFinite(value) && value > 0 ? value : null)
      .then(() => setCapacityDraft(null))
      .catch(() => {})
  }
  const remoteDevices = network.devices
  const streamingNow = streams.filter((s) => s.deviceName !== 'This PC').length

  return (
    <div className="page dash">
      <h1 className="page-title">Dashboard</h1>
      <p className="dash-summary">
        {streams.length === 0
          ? 'Nothing playing right now.'
          : `${streams.length} playing` +
            (streamingNow ? ` · ${formatMbps(network.currentMbps)} upload` : '')}
      </p>

      <section className="dash-section">
        <h2>Now Playing</h2>
        {streams.length === 0 ? (
          <p className="empty-state-inline">When someone plays something, it shows up here.</p>
        ) : (
          <div className="dash-streams">
            {streams.map((stream) => (
              <StreamCard
                key={stream.key}
                stream={stream}
                port={port}
                onStop={(message) =>
                  window.api.dashboard
                    .stopStream(activeProfile.id, stream.key, message)
                    .then(() => undefined)
                }
              />
            ))}
          </div>
        )}
      </section>

      <section className="dash-section">
        <div className="dash-section-head">
          <h2>Network</h2>
          <div className="dash-upload-now">
            <span className="dash-upload-value">{formatMbps(network.currentMbps)}</span>
            <span className="dash-upload-label">
              {capacity ? `of ${Math.round(capacity)} Mbps upload` : 'upload to remote devices'}
            </span>
          </div>
        </div>
        <UploadChart samples={network.samples} capacity={capacity} />
        <div className="dash-capacity">
          <label>
            Your internet upload speed
            <input
              type="number"
              min="1"
              placeholder="e.g. 500"
              value={capacityDraft ?? (capacity ? String(capacity) : '')}
              onChange={(e) => setCapacityDraft(e.target.value)}
              onBlur={saveCapacity}
              onKeyDown={(e) => e.key === 'Enter' && saveCapacity()}
            />
            Mbps
          </label>
          <span className="settings-hint">
            From a speed test on this PC — the chart and totals are measured against it.
          </span>
        </div>

        {remoteDevices.length === 0 ? (
          <p className="empty-state-inline">
            No signed-in devices yet. Add them under Settings → Users.
          </p>
        ) : (
          <table className="dash-devices">
            <thead>
              <tr>
                <th>Device</th>
                <th>Connection</th>
                <th>Speed test</th>
                <th>Now</th>
                <th>Today</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {remoteDevices.map((device) => {
                const path = pathLabel(device)
                return (
                  <tr key={device.deviceId}>
                    <td>
                      <div className="dash-device-name">{device.deviceName}</div>
                      <div className="dash-device-user">{device.profileName}</div>
                    </td>
                    <td>
                      <span className={`dash-badge dash-badge-${path.tone}`}>{path.text}</span>
                    </td>
                    <td>
                      {device.speedMbps !== null ? (
                        <>
                          {formatMbps(device.speedMbps)}
                          {device.latencyMs !== null && (
                            <span className="dash-dim"> · {Math.round(device.latencyMs)} ms</span>
                          )}
                          <div className="dash-dim">{timeAgo(device.speedTestedAt)}</div>
                        </>
                      ) : (
                        <span className="dash-dim">not yet</span>
                      )}
                    </td>
                    <td>
                      {device.mbps > 0 ? (
                        formatMbps(device.mbps)
                      ) : (
                        <span className="dash-dim">—</span>
                      )}
                    </td>
                    <td>{formatBytes(device.bytesToday)}</td>
                    <td className="dash-dim">{timeAgo(device.lastSeenAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
