import type { MusicTrack } from '../../../shared/types'

// The desktop music player. Tracks are decoded whole with the Web Audio API
// and the next one is scheduled to start on the exact sample the current
// one ends, so albums play without gaps (an <audio> element always leaves
// one). Only the playing track and the next are held decoded.

export type RepeatMode = 'off' | 'all' | 'one'

export interface MusicState {
  queue: MusicTrack[]
  // Index into queue of what's playing, -1 when nothing is.
  index: number
  playing: boolean
  loading: boolean
  positionSeconds: number
  shuffle: boolean
  repeat: RepeatMode
  volume: number
  error: string | null
  // How the current track is being sent (lossless original or AAC).
  format: 'original' | 'alac' | 'aac' | null
}

type Listener = (state: MusicState) => void

interface Loaded {
  track: MusicTrack
  buffer: AudioBuffer
  format: 'original' | 'alac' | 'aac'
}

// What this player decodes, for the server's choice of original or AAC.
function accepts(): string {
  const a = new Audio()
  const can = (type: string): boolean => a.canPlayType(type) !== ''
  const list = ['mp3', 'aac']
  if (can('audio/flac')) list.push('flac')
  if (can('audio/ogg; codecs="opus"')) list.push('opus')
  if (can('audio/ogg; codecs="vorbis"')) list.push('vorbis')
  if (can('audio/wav')) list.push('wav')
  if (can('audio/mp4; codecs="alac"')) list.push('alac')
  return list.join(',')
}

class MusicPlayer {
  private port = 0
  private profile: { profileId: number; pin: string | null } | null = null
  private counted: object | null = null
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private listeners = new Set<Listener>()
  private current: { loaded: Loaded; source: AudioBufferSourceNode; startedAt: number; offset: number } | null = null
  private next: { loaded: Loaded; source: AudioBufferSourceNode | null; index: number } | null = null
  private loads = new Map<number, Promise<Loaded>>()
  private order: number[] = [] // play order (shuffled or not) as queue indexes
  private ticker: number | null = null
  private generation = 0
  state: MusicState = {
    queue: [],
    index: -1,
    playing: false,
    loading: false,
    positionSeconds: 0,
    shuffle: false,
    repeat: 'off',
    volume: 1,
    error: null,
    format: null
  }

  setPort(port: number): void {
    this.port = port
  }

  // Whose listening history a played song goes into.
  setProfile(profileId: number, pin: string | null): void {
    this.profile = { profileId, pin }
  }

  // A song counts as played (Recently Played, Most Played) once half of it,
  // or four minutes, has played.
  private countPlay(cur: object, trackId: number, position: number, duration: number): void {
    if (this.counted === cur || !this.profile || position < Math.min(duration / 2, 240)) return
    this.counted = cur
    void fetch(`http://127.0.0.1:${this.port}/api/music/plays`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...this.profile, trackId })
    }).catch(() => undefined)
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.state)
    return () => this.listeners.delete(fn)
  }

  private emit(patch: Partial<MusicState>): void {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn(this.state)
  }

  private audio(): { ctx: AudioContext; gain: GainNode } {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.gain = this.ctx.createGain()
      this.gain.gain.value = this.state.volume
      this.gain.connect(this.ctx.destination)
    }
    return { ctx: this.ctx, gain: this.gain! }
  }

  get track(): MusicTrack | null {
    return this.state.queue[this.state.index] ?? null
  }

  get durationSeconds(): number {
    return this.current?.loaded.buffer.duration ?? this.track?.durationSeconds ?? 0
  }

  coverUrl(albumId: number): string {
    return `http://127.0.0.1:${this.port}/api/music/albums/${albumId}/cover`
  }

  private load(track: MusicTrack): Promise<Loaded> {
    const cached = this.loads.get(track.id)
    if (cached) return cached
    const job = (async () => {
      const base = `http://127.0.0.1:${this.port}/api/music/tracks/${track.id}`
      const plan = await fetch(`${base}/play?accepts=${accepts()}`).then((r) => r.json())
      const bytes = await fetch(`http://127.0.0.1:${this.port}${plan.path}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.arrayBuffer()
      })
      const buffer = await this.audio().ctx.decodeAudioData(bytes)
      return { track, buffer, format: plan.format } as Loaded
    })()
    this.loads.set(track.id, job)
    job.catch(() => this.loads.delete(track.id))
    return job
  }

  // Keep only what's playing and what's next decoded.
  private forgetOthers(): void {
    const keep = new Set([this.track?.id, this.next?.loaded.track.id, this.peekNext()?.track.id])
    for (const id of this.loads.keys()) if (!keep.has(id)) this.loads.delete(id)
  }

  private buildOrder(startAt: number): void {
    const n = this.state.queue.length
    const rest = Array.from({ length: n }, (_, i) => i).filter((i) => i !== startAt)
    if (this.state.shuffle) {
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[rest[i], rest[j]] = [rest[j], rest[i]]
      }
      this.order = [startAt, ...rest]
    } else {
      this.order = Array.from({ length: n }, (_, i) => i)
    }
  }

  private peekNext(): { index: number; track: MusicTrack } | null {
    const { repeat, index, queue } = this.state
    if (index < 0) return null
    if (repeat === 'one') return { index, track: queue[index] }
    const pos = this.order.indexOf(index)
    let nextPos = pos + 1
    if (nextPos >= this.order.length) {
      if (repeat !== 'all') return null
      nextPos = 0
    }
    const i = this.order[nextPos]
    return i === undefined ? null : { index: i, track: queue[i] }
  }

  private previousIndex(): number | null {
    const pos = this.order.indexOf(this.state.index)
    if (pos > 0) return this.order[pos - 1]
    return this.state.repeat === 'all' ? this.order[this.order.length - 1] : null
  }

  /** Replaces the queue and plays from `startIndex`. */
  async playQueue(tracks: MusicTrack[], startIndex = 0, opts: { shuffle?: boolean } = {}): Promise<void> {
    if (tracks.length === 0) return
    const shuffle = opts.shuffle ?? this.state.shuffle
    const start = opts.shuffle ? Math.floor(Math.random() * tracks.length) : startIndex
    this.emit({ queue: tracks, shuffle })
    this.buildOrder(start)
    await this.playIndex(start, 0)
  }

  /** Adds tracks after the current one (or at the end). */
  enqueue(tracks: MusicTrack[], playNext: boolean): void {
    if (this.state.index < 0) {
      void this.playQueue(tracks, 0)
      return
    }
    // Inserted after the playing track or at the end, so its index stays.
    const queue = [...this.state.queue]
    queue.splice(playNext ? this.state.index + 1 : queue.length, 0, ...tracks)
    this.emit({ queue })
    if (this.state.shuffle) this.buildOrder(this.state.index)
    else this.order = Array.from({ length: queue.length }, (_, i) => i)
    this.rescheduleNext()
  }

  private stopSources(): void {
    for (const s of [this.current?.source, this.next?.source]) {
      if (!s) continue
      s.onended = null
      try {
        s.stop()
      } catch {
        /* never started */
      }
      s.disconnect()
    }
    this.current = null
    this.next = null
  }

  private async playIndex(index: number, offset: number): Promise<void> {
    const generation = ++this.generation
    this.stopSources()
    const track = this.state.queue[index]
    if (!track) return
    this.emit({ index, loading: true, positionSeconds: offset, error: null, playing: true })
    this.mediaSession(track)
    let loaded: Loaded
    try {
      loaded = await this.load(track)
    } catch (err) {
      if (generation !== this.generation) return
      this.emit({ loading: false, playing: false, error: `Couldn't play “${track.title}”.` })
      return
    }
    if (generation !== this.generation) return
    const { ctx, gain } = this.audio()
    if (ctx.state === 'suspended') await ctx.resume()
    const source = ctx.createBufferSource()
    source.buffer = loaded.buffer
    source.connect(gain)
    const startedAt = ctx.currentTime + 0.05
    source.start(startedAt, offset)
    this.current = { loaded, source, startedAt, offset }
    this.emit({ loading: false, format: loaded.format })
    this.startTicker()
    this.rescheduleNext()
  }

  // Decodes the next track and schedules it to start the moment the
  // current one ends — the gapless part.
  private rescheduleNext(): void {
    const gen = this.generation
    if (this.next?.source) {
      this.next.source.onended = null
      try {
        this.next.source.stop()
      } catch {
        /* fine */
      }
      this.next.source.disconnect()
    }
    this.next = null
    const upcoming = this.peekNext()
    this.forgetOthers()
    if (!upcoming || !this.current) return
    void this.load(upcoming.track).then((loaded) => {
      if (gen !== this.generation || !this.current || this.peekNext()?.index !== upcoming.index) return
      const { ctx, gain } = this.audio()
      const source = ctx.createBufferSource()
      source.buffer = loaded.buffer
      source.connect(gain)
      const endsAt = this.current.startedAt + (this.current.loaded.buffer.duration - this.current.offset)
      if (endsAt > ctx.currentTime + 0.02) {
        source.start(endsAt)
        this.next = { loaded, source, index: upcoming.index }
      }
    }).catch(() => {
      /* tried again when its turn comes */
    })
  }

  private startTicker(): void {
    if (this.ticker !== null) return
    this.ticker = window.setInterval(() => this.tick(), 250)
  }

  private tick(): void {
    const cur = this.current
    if (!cur || !this.ctx) return
    const elapsed = this.ctx.currentTime - cur.startedAt
    const position = cur.offset + Math.max(0, elapsed)
    const duration = cur.loaded.buffer.duration
    if (position < duration) {
      this.countPlay(cur, cur.loaded.track.id, position, duration)
      if (this.state.playing && Math.abs(position - this.state.positionSeconds) > 0.2) this.emit({ positionSeconds: position })
      return
    }
    // The current track ended: the next is already playing (gapless), or
    // there was nothing next.
    const nxt = this.next
    if (nxt && nxt.source) {
      const startedAt = cur.startedAt + (duration - cur.offset)
      this.current = { loaded: nxt.loaded, source: nxt.source, startedAt, offset: 0 }
      this.next = null
      this.emit({ index: nxt.index, positionSeconds: Math.max(0, this.ctx.currentTime - startedAt), format: nxt.loaded.format })
      this.mediaSession(nxt.loaded.track)
      this.rescheduleNext()
      return
    }
    const upcoming = this.peekNext()
    if (upcoming) {
      void this.playIndex(upcoming.index, 0)
    } else {
      this.stopSources()
      this.emit({ playing: false, positionSeconds: 0 })
    }
  }

  async toggle(): Promise<void> {
    if (this.state.index < 0) return
    const { ctx } = this.audio()
    if (this.state.playing) {
      await ctx.suspend()
      this.emit({ playing: false })
    } else if (!this.current) {
      await this.playIndex(this.state.index, this.state.positionSeconds)
    } else {
      await ctx.resume()
      this.emit({ playing: true })
    }
  }

  pause(): void {
    if (this.state.playing) void this.toggle()
  }

  seek(seconds: number): void {
    if (this.state.index < 0) return
    const clamped = Math.max(0, Math.min(seconds, this.durationSeconds - 0.25))
    const wasPlaying = this.state.playing
    void this.playIndex(this.state.index, clamped).then(async () => {
      if (!wasPlaying) {
        await this.ctx?.suspend()
        this.emit({ playing: false })
      }
    })
  }

  skipNext(): void {
    // A press always moves on, even with repeat-one.
    const pos = this.order.indexOf(this.state.index)
    let target = this.order[pos + 1]
    if (target === undefined) {
      if (this.state.repeat === 'off') return
      target = this.order[0]
    }
    void this.playIndex(target, 0)
  }

  skipPrevious(): void {
    // Back to the start first, like every player; a second press goes back.
    if (this.state.positionSeconds > 3) {
      this.seek(0)
      return
    }
    const prev = this.previousIndex()
    if (prev === null) this.seek(0)
    else void this.playIndex(prev, 0)
  }

  playAt(index: number): void {
    if (index < 0 || index >= this.state.queue.length) return
    void this.playIndex(index, 0)
  }

  setShuffle(on: boolean): void {
    this.emit({ shuffle: on })
    if (this.state.index >= 0) this.buildOrder(this.state.index)
    this.rescheduleNext()
  }

  cycleRepeat(): void {
    const next: RepeatMode = this.state.repeat === 'off' ? 'all' : this.state.repeat === 'all' ? 'one' : 'off'
    this.emit({ repeat: next })
    this.rescheduleNext()
  }

  setVolume(v: number): void {
    const volume = Math.max(0, Math.min(1, v))
    if (this.gain) this.gain.gain.value = volume
    this.emit({ volume })
  }

  // The OS media keys and its now-playing panel.
  private mediaSession(track: MusicTrack): void {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: track.hasCover ? [{ src: this.coverUrl(track.albumId), sizes: '600x600', type: 'image/jpeg' }] : []
    })
    navigator.mediaSession.setActionHandler('play', () => void this.toggle())
    navigator.mediaSession.setActionHandler('pause', () => void this.toggle())
    navigator.mediaSession.setActionHandler('nexttrack', () => this.skipNext())
    navigator.mediaSession.setActionHandler('previoustrack', () => this.skipPrevious())
  }
}

export const musicPlayer = new MusicPlayer()
