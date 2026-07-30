import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  ContinueWatchingItem,
  Episode,
  Library,
  MediaType,
  Movie,
  ScanProgress,
  Show,
  WatchProgress
} from '../shared/types'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args)
}

const api = {
  library: {
    list: () => invoke<Library[]>('library:list'),
    pickFolder: () => invoke<string | null>('library:pickFolder'),
    add: (path: string, type: 'movie' | 'tv') => invoke<Library>('library:add', path, type),
    remove: (id: number) => invoke<void>('library:remove', id),
    scan: (id: number) => invoke<void>('library:scan', id),
    onScanProgress: (cb: (progress: ScanProgress) => void) => {
      const listener = (_e: unknown, progress: ScanProgress): void => cb(progress)
      ipcRenderer.on('library:scanProgress', listener)
      return () => {
        ipcRenderer.removeListener('library:scanProgress', listener)
      }
    }
  },
  movies: {
    list: (libraryId?: number) => invoke<Movie[]>('movies:list', libraryId),
    get: (id: number) => invoke<Movie | null>('movies:get', id)
  },
  shows: {
    list: (libraryId?: number) => invoke<Show[]>('shows:list', libraryId),
    get: (id: number) => invoke<Show | null>('shows:get', id),
    episodes: (showId: number) => invoke<Episode[]>('shows:episodes', showId),
    nextEpisode: (showId: number) => invoke<Episode | null>('shows:nextEpisode', showId)
  },
  episodes: {
    get: (id: number) => invoke<Episode | null>('episodes:get', id)
  },
  progress: {
    save: (mediaType: MediaType, mediaId: number, position: number, duration: number) =>
      invoke<void>('progress:save', mediaType, mediaId, position, duration),
    get: (mediaType: MediaType, mediaId: number) =>
      invoke<WatchProgress | null>('progress:get', mediaType, mediaId),
    setWatched: (mediaType: MediaType, mediaId: number, watched: boolean) =>
      invoke<void>('progress:setWatched', mediaType, mediaId, watched)
  },
  continueWatching: {
    list: () => invoke<ContinueWatchingItem[]>('continueWatching:list')
  },
  settings: {
    get: () => invoke<AppSettings>('settings:get'),
    setTmdbKey: (key: string) => invoke<boolean>('settings:setTmdbKey', key)
  },
  media: {
    serverPort: () => invoke<number>('media:serverPort')
  }
}

contextBridge.exposeInMainWorld('api', api)

export type OvrlookApi = typeof api
