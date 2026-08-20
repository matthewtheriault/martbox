import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActivityItem,
  AppSettings,
  ContinueWatchingItem,
  Episode,
  IptvChannel,
  IptvHealthProgress,
  IptvHealthSummary,
  IptvRefreshResult,
  IptvSettingsInfo,
  Library,
  MediaType,
  Movie,
  MovieMetadataPatch,
  MovieSearchResult,
  Profile,
  ScanProgress,
  Show,
  ShowMetadataPatch,
  ShowSearchResult,
  UpdateCheckResult,
  WatchlistItem,
  WatchlistMediaType,
  WatchProgress
} from '../shared/types'
import type { RemoteAccessStatus, TailscaleGuestDevice } from '../shared/remoteAccess'

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
    },
    getSeenAt: (profileId: number, pin?: string | null) =>
      invoke<{ movies: string | null; shows: string | null }>('library:getSeenAt', profileId, pin),
    markSeen: (profileId: number, mediaType: 'movie' | 'show', pin?: string | null) =>
      invoke<void>('library:markSeen', profileId, mediaType, pin)
  },
  movies: {
    list: (libraryId?: number) => invoke<Movie[]>('movies:list', libraryId),
    get: (id: number) => invoke<Movie | null>('movies:get', id),
    search: (query: string) => invoke<MovieSearchResult[]>('movies:search', query),
    applyMatch: (movieId: number, tmdbId: number) =>
      invoke<Movie>('movies:applyMatch', movieId, tmdbId),
    update: (id: number, patch: MovieMetadataPatch) => invoke<Movie>('movies:update', id, patch),
    delete: (id: number) => invoke<{ deleted: boolean }>('movies:delete', id),
    recommendations: (movieId: number) => invoke<Movie[]>('movies:recommendations', movieId),
    collection: (movieId: number) => invoke<Movie[]>('movies:collection', movieId)
  },
  shows: {
    list: (libraryId?: number) => invoke<Show[]>('shows:list', libraryId),
    get: (id: number) => invoke<Show | null>('shows:get', id),
    episodes: (showId: number) => invoke<Episode[]>('shows:episodes', showId),
    nextEpisode: (profileId: number, showId: number) =>
      invoke<Episode | null>('shows:nextEpisode', profileId, showId),
    search: (query: string) => invoke<ShowSearchResult[]>('shows:search', query),
    applyMatch: (showId: number, tmdbId: number) => invoke<Show>('shows:applyMatch', showId, tmdbId),
    update: (id: number, patch: ShowMetadataPatch) => invoke<Show>('shows:update', id, patch),
    merge: (targetId: number, sourceIds: number[]) =>
      invoke<Show>('shows:merge', targetId, sourceIds),
    delete: (id: number) => invoke<{ deleted: boolean }>('shows:delete', id),
    recommendations: (showId: number) => invoke<Show[]>('shows:recommendations', showId)
  },
  search: {
    library: (query: string) => invoke<{ movies: Movie[]; shows: Show[] }>('search:library', query)
  },
  episodes: {
    get: (id: number) => invoke<Episode | null>('episodes:get', id)
  },
  profiles: {
    list: () => invoke<Profile[]>('profiles:list'),
    create: (name: string, avatarId: string) =>
      invoke<Profile>('profiles:create', name, avatarId),
    rename: (id: number, name: string) => invoke<void>('profiles:rename', id, name),
    remove: (id: number) => invoke<void>('profiles:remove', id),
    setPin: (requestingProfileId: number, targetProfileId: number, pin: string | null) =>
      invoke<void>('profiles:setPin', requestingProfileId, targetProfileId, pin),
    verifyPin: (profileId: number, pin: string) =>
      invoke<boolean>('profiles:verifyPin', profileId, pin),
    listWithPins: (requestingProfileId: number) =>
      invoke<Array<Profile & { pin: string | null }>>('profiles:listWithPins', requestingProfileId)
  },
  progress: {
    save: (
      profileId: number,
      mediaType: MediaType,
      mediaId: number,
      position: number,
      duration: number,
      pin?: string | null
    ) => invoke<void>('progress:save', profileId, mediaType, mediaId, position, duration, pin),
    get: (profileId: number, mediaType: MediaType, mediaId: number, pin?: string | null) =>
      invoke<WatchProgress | null>('progress:get', profileId, mediaType, mediaId, pin),
    setWatched: (
      profileId: number,
      mediaType: MediaType,
      mediaId: number,
      watched: boolean,
      pin?: string | null
    ) => invoke<void>('progress:setWatched', profileId, mediaType, mediaId, watched, pin)
  },
  continueWatching: {
    list: (profileId: number, pin?: string | null) =>
      invoke<ContinueWatchingItem[]>('continueWatching:list', profileId, pin)
  },
  iptv: {
    list: () => invoke<IptvChannel[]>('iptv:list'),
    getSettings: () => invoke<IptvSettingsInfo>('iptv:getSettings'),
    refresh: (m3uUrl: string, epgUrl: string) =>
      invoke<IptvRefreshResult>('iptv:refresh', m3uUrl, epgUrl),
    verifyChannels: () => invoke<void>('iptv:verifyChannels'),
    getHealthSummary: () => invoke<IptvHealthSummary>('iptv:getHealthSummary'),
    onHealthProgress: (cb: (progress: IptvHealthProgress) => void) => {
      const listener = (_e: unknown, progress: IptvHealthProgress): void => cb(progress)
      ipcRenderer.on('iptv:healthProgress', listener)
      return () => {
        ipcRenderer.removeListener('iptv:healthProgress', listener)
      }
    }
  },
  activity: {
    list: () => invoke<ActivityItem[]>('activity:list')
  },
  watchlist: {
    list: (profileId: number, pin?: string | null) =>
      invoke<WatchlistItem[]>('watchlist:list', profileId, pin),
    has: (profileId: number, mediaType: WatchlistMediaType, mediaId: number, pin?: string | null) =>
      invoke<boolean>('watchlist:has', profileId, mediaType, mediaId, pin),
    add: (profileId: number, mediaType: WatchlistMediaType, mediaId: number, pin?: string | null) =>
      invoke<void>('watchlist:add', profileId, mediaType, mediaId, pin),
    remove: (profileId: number, mediaType: WatchlistMediaType, mediaId: number, pin?: string | null) =>
      invoke<void>('watchlist:remove', profileId, mediaType, mediaId, pin)
  },
  settings: {
    get: () => invoke<AppSettings>('settings:get'),
    setTmdbKey: (key: string) => invoke<boolean>('settings:setTmdbKey', key)
  },
  media: {
    serverPort: () => invoke<number>('media:serverPort')
  },
  system: {
    showInFolder: (path: string) => invoke<void>('system:showInFolder', path),
    openExternal: (url: string) => invoke<void>('system:openExternal', url)
  },
  updates: {
    check: () => invoke<UpdateCheckResult>('updates:check'),
    getCheckUrl: () => invoke<string | null>('updates:getCheckUrl'),
    setCheckUrl: (url: string) => invoke<void>('updates:setCheckUrl', url),
    openDownload: (url: string) => invoke<void>('updates:openDownload', url)
  },
  remoteAccess: {
    getStatus: () => invoke<RemoteAccessStatus>('remoteAccess:getStatus'),
    hasApiToken: () => invoke<boolean>('remoteAccess:hasApiToken'),
    saveApiToken: (token: string) => invoke<boolean>('remoteAccess:saveApiToken', token),
    enableHost: () => invoke<void>('remoteAccess:enableHost'),
    generateInvite: () => invoke<string>('remoteAccess:generateInvite'),
    connectClient: (code: string) => invoke<void>('remoteAccess:connectClient', code),
    disable: () => invoke<void>('remoteAccess:disable'),
    listGuests: () => invoke<TailscaleGuestDevice[]>('remoteAccess:listGuests'),
    revokeGuest: (deviceId: string) => invoke<void>('remoteAccess:revokeGuest', deviceId),
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
