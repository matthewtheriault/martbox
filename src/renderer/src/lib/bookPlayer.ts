import { useEffect, useState } from 'react'
import type { AudiobookChapter, AudiobookDetail } from '../../../shared/types'
import { onFocusLost, takeFocus } from './audioFocus'

// The audiobook player: one <audio> element playing the book's files one
// after another on a single timeline, with chapters, speed, a sleep timer,
// and the place saved to the server (so another device picks up there).
// Unlike music, books aren't decoded whole into memory — they're hours long.

export type SleepTimer = { kind: 'minutes'; endsAt: number } | { kind: 'chapter'; chapterEnd: number } | null

export interface BookState {
  book: AudiobookDetail | null
  playing: boolean
  loading: boolean
  // Seconds on the book's timeline.
  positionSeconds: number
  speed: number
  sleep: SleepTimer
  error: string | null
}

type Listener = (s: BookState) => void

export const SPEEDS = [0.8, 1, 1.1, 1.25, 1.5, 1.75, 2]
const SAVE_EVERY_MS = 15_000
// "Back" and "forward" buttons, in seconds.
export const SKIP_BACK = 15
export const SKIP_FORWARD = 30

class BookPlayer {
  private port = 0
  private profile: { profileId: number; pin: string | null } | null = null
  private audio = new Audio()
  private fileIndex = 0
  private listeners = new Set<Listener>()
  private lastSaved = 0
  private ticker: number | null = null
  state: BookState = { book: null, playing: false, loading: false, positionSeconds: 0, speed: 1, sleep: null, error: null }

  constructor() {
    this.audio.preload = 'auto'
    this.audio.addEventListener('timeupdate', () => this.onTime())
    this.audio.addEventListener('ended', () => void this.onFileEnded())
    this.audio.addEventListener('playing', () => this.emit({ playing: true, loading: false }))
    this.audio.addEventListener('pause', () => this.emit({ playing: false }))
    this.audio.addEventListener('waiting', () => this.emit({ loading: true }))
    this.audio.addEventListener('error', () => this.emit({ loading: false, playing: false, error: "Couldn't play this book." }))
    onFocusLost('book', () => this.pause())
    try {
      const saved = parseFloat(localStorage.getItem('martbox.bookSpeed') ?? '')
      if (SPEEDS.includes(saved)) this.state.speed = saved
    } catch {
      /* no storage: default speed */
    }
  }

  setPort(port: number): void {
    this.port = port
  }

  setProfile(profileId: number, pin: string | null): void {
    this.profile = { profileId, pin }
  }

  coverUrl(bookId: number): string {
    return `http://127.0.0.1:${this.port}/api/audiobooks/${bookId}/cover`
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.state)
    return () => this.listeners.delete(fn)
  }

  private emit(patch: Partial<BookState>): void {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn(this.state)
  }

  // The file holding a point on the book's timeline, and the offset in it.
  private locate(book: AudiobookDetail, position: number): { index: number; offset: number } {
    let index = book.files.length - 1
    for (let i = 0; i < book.files.length; i++) {
      if (position < book.files[i].start + book.files[i].durationSeconds) {
        index = i
        break
      }
    }
    return { index, offset: Math.max(0, position - book.files[index].start) }
  }

  private streamUrl(bookId: number, index: number): string {
    // Chromium plays all of these itself.
    return `http://127.0.0.1:${this.port}/api/audiobooks/${bookId}/files/${index}/stream?accepts=aac,mp3,opus,vorbis,flac`
  }

  private async loadFile(index: number, offset: number, autoplay: boolean): Promise<void> {
    const book = this.state.book
    if (!book) return
    this.fileIndex = index
    this.audio.src = this.streamUrl(book.id, index)
    this.audio.playbackRate = this.state.speed
    this.emit({ loading: true, error: null })
    await new Promise<void>((resolve) => {
      const ready = (): void => {
        this.audio.removeEventListener('loadedmetadata', ready)
        resolve()
      }
      this.audio.addEventListener('loadedmetadata', ready)
    })
    this.audio.currentTime = offset
    this.audio.playbackRate = this.state.speed
    if (autoplay) await this.audio.play().catch(() => this.emit({ playing: false }))
    this.emit({ loading: false })
  }

  /** Opens a book at a point (its saved place, a chapter) and plays it. */
  async open(book: AudiobookDetail, position: number): Promise<void> {
    takeFocus('book')
    if (this.state.book && this.state.book.id !== book.id) this.saveNow()
    this.emit({ book, positionSeconds: position, sleep: null })
    this.mediaSession(book)
    const { index, offset } = this.locate(book, position)
    await this.loadFile(index, offset, true)
    this.startTicker()
  }

  async toggle(): Promise<void> {
    if (!this.state.book) return
    if (this.audio.paused) {
      takeFocus('book')
      if (!this.audio.src) {
        const { index, offset } = this.locate(this.state.book, this.state.positionSeconds)
        await this.loadFile(index, offset, true)
      } else await this.audio.play().catch(() => undefined)
      this.startTicker()
    } else this.pause()
  }

  pause(): void {
    if (!this.audio.paused) this.audio.pause()
    this.saveNow()
  }

  async seek(position: number): Promise<void> {
    const book = this.state.book
    if (!book) return
    const clamped = Math.max(0, Math.min(position, book.durationSeconds - 0.5))
    const { index, offset } = this.locate(book, clamped)
    this.emit({ positionSeconds: clamped })
    if (index !== this.fileIndex || !this.audio.src) await this.loadFile(index, offset, !this.audio.paused || this.state.playing)
    else this.audio.currentTime = offset
    this.saveNow()
  }

  skip(seconds: number): void {
    void this.seek(this.state.positionSeconds + seconds)
  }

  chapterAt(position = this.state.positionSeconds): { chapter: AudiobookChapter; index: number } | null {
    const chapters = this.state.book?.chapters ?? []
    for (let i = chapters.length - 1; i >= 0; i--) if (position >= chapters[i].start - 0.01) return { chapter: chapters[i], index: i }
    return null
  }

  nextChapter(): void {
    const at = this.chapterAt()
    const chapters = this.state.book?.chapters ?? []
    if (at && at.index + 1 < chapters.length) void this.seek(chapters[at.index + 1].start)
  }

  /** To the start of this chapter, or the one before when already near its start. */
  previousChapter(): void {
    const at = this.chapterAt()
    if (!at) return
    const chapters = this.state.book!.chapters
    const target = this.state.positionSeconds - at.chapter.start < 3 && at.index > 0 ? chapters[at.index - 1] : at.chapter
    void this.seek(target.start)
  }

  setSpeed(speed: number): void {
    this.audio.playbackRate = speed
    this.emit({ speed })
    try {
      localStorage.setItem('martbox.bookSpeed', String(speed))
    } catch {
      /* not remembered */
    }
  }

  /** Minutes, 'chapter' (stop when this chapter ends), or null to cancel. */
  setSleep(choice: number | 'chapter' | null): void {
    if (choice === null) this.emit({ sleep: null })
    else if (choice === 'chapter') {
      const at = this.chapterAt()
      this.emit({ sleep: at ? { kind: 'chapter', chapterEnd: at.chapter.end } : null })
    } else this.emit({ sleep: { kind: 'minutes', endsAt: Date.now() + choice * 60_000 } })
  }

  /** Marks the book finished (or not) without playing it. */
  async markFinished(book: AudiobookDetail, finished: boolean): Promise<void> {
    await this.post(book.id, finished ? book.durationSeconds : 0, finished)
  }

  private onTime(): void {
    const book = this.state.book
    if (!book) return
    const position = book.files[this.fileIndex].start + this.audio.currentTime
    if (Math.abs(position - this.state.positionSeconds) > 0.25) this.emit({ positionSeconds: position })
    const sleep = this.state.sleep
    if (sleep?.kind === 'chapter' && position >= sleep.chapterEnd - 0.3) {
      this.emit({ sleep: null })
      this.pause()
    }
  }

  private async onFileEnded(): Promise<void> {
    const book = this.state.book
    if (!book) return
    if (this.fileIndex + 1 < book.files.length) {
      await this.loadFile(this.fileIndex + 1, 0, true)
      return
    }
    // The end of the book.
    this.emit({ playing: false, positionSeconds: book.durationSeconds, sleep: null })
    void this.post(book.id, book.durationSeconds, true)
  }

  private startTicker(): void {
    if (this.ticker !== null) return
    this.ticker = window.setInterval(() => {
      const sleep = this.state.sleep
      if (sleep?.kind === 'minutes' && Date.now() >= sleep.endsAt) {
        this.emit({ sleep: null })
        this.pause()
      }
      if (this.state.playing && Date.now() - this.lastSaved >= SAVE_EVERY_MS) this.saveNow()
    }, 1000)
  }

  private saveNow(): void {
    const book = this.state.book
    if (!book) return
    this.lastSaved = Date.now()
    // Finished within its last 30 seconds (or 3%, for a short book).
    const finished = book.durationSeconds - this.state.positionSeconds < Math.min(30, book.durationSeconds * 0.03)
    void this.post(book.id, this.state.positionSeconds, finished)
  }

  private async post(bookId: number, positionSeconds: number, finished: boolean): Promise<void> {
    if (!this.profile) return
    await fetch(`http://127.0.0.1:${this.port}/api/audiobooks/${bookId}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...this.profile, positionSeconds, finished })
    }).catch(() => undefined)
  }

  private mediaSession(book: AudiobookDetail): void {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: book.title,
      artist: book.author,
      artwork: book.hasCover ? [{ src: this.coverUrl(book.id) }] : []
    })
    navigator.mediaSession.setActionHandler('play', () => void this.toggle())
    navigator.mediaSession.setActionHandler('pause', () => this.pause())
    navigator.mediaSession.setActionHandler('seekbackward', () => this.skip(-SKIP_BACK))
    navigator.mediaSession.setActionHandler('seekforward', () => this.skip(SKIP_FORWARD))
    navigator.mediaSession.setActionHandler('previoustrack', () => this.previousChapter())
    navigator.mediaSession.setActionHandler('nexttrack', () => this.nextChapter())
  }
}

export const bookPlayer = new BookPlayer()

export function useBookPlayer(): BookState {
  const [state, setState] = useState(bookPlayer.state)
  useEffect(() => bookPlayer.subscribe(setState), [])
  return state
}
