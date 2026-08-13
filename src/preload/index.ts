import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActivityItem,
  AppSettings,
  ContinueWatchingItem,
  Episode,
  IptvChannel,
  IptvRefreshResult,
  IptvSettingsInfo,
  Library,
  MediaType,
  Movie,
  Profile,
  ScanProgress,
  Show,
  WatchProgress
} from '../shared/types'
import type { RemoteAccessStatus } from '../shared/remoteAccess'

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
    nextEpisode: (profileId: number, showId: number) =>
      invoke<Episode | null>('shows:nextEpisode', profileId, showId)
  },
  episodes: {
    get: (id: number) => invoke<Episode | null>('episodes:get', id)
  },
  profiles: {
    list: () => invoke<Profile[]>('profiles:list'),
    create: (name: string, avatarId: string) =>
      invoke<Profile>('profiles:create', name, avatarId),
    rename: (id: number, name: string) => invoke<void>('profiles:rename', id, name),
    remove: (id: number) => invoke<void>('profiles:remove', id)
  },
  progress: {
    save: (
      profileId: number,
      mediaType: MediaType,
      mediaId: number,
      position: number,
      duration: number
    ) => invoke<void>('progress:save', profileId, mediaType, mediaId, position, duration),
    get: (profileId: number, mediaType: MediaType, mediaId: number) =>
      invoke<WatchProgress | null>('progress:get', profileId, mediaType, mediaId),
    setWatched: (profileId: number, mediaType: MediaType, mediaId: number, watched: boolean) =>
      invoke<void>('progress:setWatched', profileId, mediaType, mediaId, watched)
  },
  continueWatching: {
    list: (profileId: number) => invoke<ContinueWatchingItem[]>('continueWatching:list', profileId)
  },
  iptv: {
    list: () => invoke<IptvChannel[]>('iptv:list'),
    getSettings: () => invoke<IptvSettingsInfo>('iptv:getSettings'),
    refresh: (m3uUrl: string, epgUrl: string) =>
      invoke<IptvRefreshResult>('iptv:refresh', m3uUrl, epgUrl)
  },
  activity: {
    list: () => invoke<ActivityItem[]>('activity:list')
  },
  settings: {
    get: () => invoke<AppSettings>('settings:get'),
    setTmdbKey: (key: string) => invoke<boolean>('settings:setTmdbKey', key)
  },
  media: {
    serverPort: () => invoke<number>('media:serverPort')
  },
  remoteAccess: {
    getStatus: () => invoke<RemoteAccessStatus>('remoteAccess:getStatus'),
    hasApiToken: () => invoke<boolean>('remoteAccess:hasApiToken'),
    saveApiToken: (token: string) => invoke<boolean>('remoteAccess:saveApiToken', token),
    enableHost: () => invoke<void>('remoteAccess:enableHost'),
    generateInvite: () => invoke<string>('remoteAccess:generateInvite'),
    connectClient: (code: string) => invoke<void>('remoteAccess:connectClient', code),
    disable: () => invoke<void>('remoteAccess:disable'),
    onStatus: (cb: (status: RemoteAccessStatus) => void) => {
      const listener = (_e: unknown, status: RemoteAccessStatus): void => cb(status)
      ipcRenderer.on('remoteAccess:status', listener)
      return () => {
        ipcRenderer.removeListener('remoteAccess:status', listener)
      }
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type MartBoxApi = typeof api
