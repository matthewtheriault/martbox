import { beforeEach, describe, expect, it } from 'vitest'
import {
  noteHeartbeat,
  notePlaybackDecision,
  onStreamStopped,
  resetDashboard,
  setMediaLookup,
  snapshot,
  stopStream,
  stoppedMessage,
  streamKey,
  type StreamOwner
} from './dashboard'

const phone: StreamOwner = {
  key: 'device:1',
  deviceId: 1,
  deviceName: "Alex's iPhone",
  profileName: 'Alex',
  profileAvatarId: null
}

setMediaLookup((mediaType, mediaId) =>
  mediaId === 404
    ? null
    : { title: `${mediaType} ${mediaId}`, subtitle: '', posterPath: null, durationSeconds: 3600 }
)

beforeEach(() => resetDashboard())

describe('dashboard streams', () => {
  it('shows a stream from its first heartbeat, with how it is sent', () => {
    notePlaybackDecision(phone, 'movie', 7, 'remux', 'Direct stream: original 2160p HEVC')
    noteHeartbeat(phone, 'movie', 7, 125, 'paused', 0)
    const [stream] = snapshot([], null, null).streams
    expect(stream).toMatchObject({
      deviceName: "Alex's iPhone",
      title: 'movie 7',
      positionSeconds: 125,
      state: 'paused',
      method: 'remux',
      durationSeconds: 3600
    })
  })

  it('ignores things not in the library', () => {
    noteHeartbeat(phone, 'movie', 404, 10, 'playing', null)
    expect(snapshot([], null, null).streams).toHaveLength(0)
  })

  it('a device plays one thing at a time', () => {
    noteHeartbeat(phone, 'movie', 1, 10, 'playing', null)
    noteHeartbeat(phone, 'episode', 2, 10, 'playing', null)
    expect(snapshot([], null, null).streams.map((s) => s.mediaId)).toEqual([2])
  })

  it('counts new stalls from the cumulative count the app sends', () => {
    noteHeartbeat(phone, 'movie', 1, 10, 'playing', 0)
    noteHeartbeat(phone, 'movie', 1, 20, 'buffering', 2)
    noteHeartbeat(phone, 'movie', 1, 30, 'playing', 2)
    expect(snapshot([], null, null).streams[0].recentStalls).toBe(2)
  })

  it('stopping ends the stream, tells listeners, and blocks it for a while', () => {
    const stoppedFor: string[] = []
    onStreamStopped((owner, mediaType, mediaId) => stoppedFor.push(`${owner} ${mediaType} ${mediaId}`))
    noteHeartbeat(phone, 'movie', 3, 10, 'playing', null)
    expect(stopStream(streamKey('device:1', 'movie', 3), '  Server maintenance  ')).toBe(true)
    expect(snapshot([], null, null).streams).toHaveLength(0)
    expect(stoppedFor).toEqual(['device:1 movie 3'])
    expect(stoppedMessage('device:1', 'movie', 3)).toBe('Server maintenance')
    expect(stoppedMessage('device:1', 'movie', 4)).toBeNull()
    expect(stopStream('nope', '')).toBe(false)
  })

  it('matches devices to their Tailscale path by address', () => {
    const device = {
      id: 1,
      name: "Alex's iPhone",
      profileName: 'Alex',
      tailscaleAddr: 'peer-a',
      speedMbps: 80,
      latencyMs: 30,
      speedTestedAt: null,
      lastSeenAt: null
    }
    const other = { ...device, id: 2, tailscaleAddr: null }
    const { devices } = snapshot(
      [device, other],
      [{ addr: 'peer-a', online: true, path: 'relayed' }],
      500
    ).network
    expect(devices[0]).toMatchObject({ path: 'relayed', online: true, speedMbps: 80, bytesToday: 0 })
    expect(devices[1]).toMatchObject({ path: null, online: null })
  })
})
