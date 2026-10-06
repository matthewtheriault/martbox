import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActivityItem,
  Channel,
  ChannelConfig,
  ChannelGuide,
  ChannelNow,
  DashboardSnapshot,
  DashboardStats,
  EmulatorStatus,
  PlayHistoryEntry,
  MediaRequest,
  MediaRequestStatus,
  RequestDiscover,
  RequestMediaType,
  RequestTitleDetails,
  RequestableTitle,
  AppSettings,
  AppUpdateStatus,
  BackupInfo,
  BackupStatus,
  Collection,
  ContinueWatchingItem,
  Episode,
  EpisodeMarkers,
  IptvChannel,
  IptvHealthProgress,
  IptvHealthSummary,
  IptvRefreshResult,
  IptvSettingsInfo,
  Library,
  LoginCodeResult,
  MediaType,
  Movie,
  MovieMetadataPatch,
  MovieSearchResult,
  Profile,
  YearInReview,
  ScanProgress,
  Show,
  ShowMetadataPatch,
  ShowSearchResult,
  SpeedTestResult,
  UserDevice,
  WatchlistItem,
  WatchlistMediaType,
  WatchProgress
} from '../shared/types'
import type {
  RemoteAccessStatus,
  RemoteSession,
  ServerCompatibility,
  TailnetPolicyCheck,
  TailscaleGuestDevice
} from '../shared/remoteAccess'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args)
}

const api = {
  // Electron sets process.mas automatically on Mac App Store builds — real
  // per-process, not a hand-maintained flag. Live TV/IPTV is hidden on MAS
  // builds only (Guideline 5.2.3 risk); the direct-download .dmg build is
  // untouched, same as it's always been. See src/main/mediaServer.ts and
  // src/main/ipc.ts for the matching main-process route/handler gating.
  isMasBuild: process.mas === true,

  games: {
    emulators: () => invoke<EmulatorStatus>('games:emulators'),
    installEmulators: () => invoke<EmulatorStatus>('games:installEmulators')
  },
  library: {
    list: () => invoke<Library[]>('library:list'),
    pickFolder: () => invoke<string | null>('library:pickFolder'),
    add: (path: string, type: Library['type']) => invoke<Library>('library:add', path, type),
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
    get: (id: number) => invoke<Episode | null>('episodes:get', id),
    markers: (id: number) => invoke<EpisodeMarkers | null>('episodes:markers', id)
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
  channels: {
    guide: (from: number, to: number) => invoke<ChannelGuide>('channels:guide', from, to),
    now: (id: number) => invoke<ChannelNow>('channels:now', id),
    list: (requestingProfileId: number) => invoke<Channel[]>('channels:list', requestingProfileId),
    save: (requestingProfileId: number, id: number | null, config: ChannelConfig) =>
      invoke<Channel>('channels:save', requestingProfileId, id, config),
    remove: (requestingProfileId: number, id: number) =>
      invoke<void>('channels:delete', requestingProfileId, id),
    pickLogo: (requestingProfileId: number) =>
      invoke<string | null>('channels:pickLogo', requestingProfileId)
  },
  yearInReview: (profileId: number, pin: string | null, year: number | null = null) =>
    invoke<YearInReview>('yearInReview:get', profileId, pin, year),
  avatars: {
    // requesting: the admin changing someone else's avatar.
    setPhoto: (
      profileId: number,
      pin: string | null,
      requesting: { profileId: number; pin: string | null } | null,
      base64: string
    ) => invoke<Profile>('profiles:setPhoto', profileId, pin, requesting, base64),
    removePhoto: (
      profileId: number,
      pin: string | null,
      requesting: { profileId: number; pin: string | null } | null
    ) => invoke<Profile>('profiles:removePhoto', profileId, pin, requesting),
    setColor: (
      profileId: number,
      pin: string | null,
      requesting: { profileId: number; pin: string | null } | null,
      color: string
    ) => invoke<Profile>('profiles:setColor', profileId, pin, requesting, color)
  },
  collections: {
    list: () => invoke<Collection[]>('collections:list'),
    get: (id: number) => invoke<Collection>('collections:get', id),
    containing: (mediaType: 'movie' | 'show', mediaId: number) =>
      invoke<number[]>('collections:containing', mediaType, mediaId),
    create: (profileId: number, pin: string | null, name: string, description = '') =>
      invoke<Collection>('collections:create', profileId, pin, name, description),
    update: (
      profileId: number,
      pin: string | null,
      id: number,
      patch: { name?: string; description?: string; onHome?: boolean }
    ) => invoke<Collection>('collections:update', profileId, pin, id, patch),
    remove: (profileId: number, pin: string | null, id: number) =>
      invoke<void>('collections:delete', profileId, pin, id),
    item: (
      profileId: number,
      pin: string | null,
      id: number,
      change: { mediaType: 'movie' | 'show'; mediaId: number; action: 'add' | 'remove' | 'move'; toIndex?: number }
    ) => invoke<Collection>('collections:item', profileId, pin, id, change)
  },
  appearance: {
    get: (profileId: number, pin: string | null) =>
      invoke<string | null>('appearance:get', profileId, pin),
    set: (profileId: number, pin: string | null, accent: string) =>
      invoke<void>('appearance:set', profileId, pin, accent)
  },
  requests: {
    discover: () => invoke<RequestDiscover>('requests:discover'),
    search: (query: string) => invoke<RequestableTitle[]>('requests:search', query),
    title: (mediaType: RequestMediaType, tmdbId: number) =>
      invoke<RequestTitleDetails>('requests:title', mediaType, tmdbId),
    mine: (profileId: number, pin?: string | null) =>
      invoke<MediaRequest[]>('requests:mine', profileId, pin),
    create: (
      profileId: number,
      pin: string | null,
      mediaType: RequestMediaType,
      tmdbId: number,
      seasons: number[] | null
    ) =>
      invoke<
        | { ok: true; request: MediaRequest }
        | { ok: false; reason: 'in-library' | 'already-requested' | 'no-seasons'; by: string | null }
      >('requests:create', profileId, pin, mediaType, tmdbId, seasons),
    cancel: (profileId: number, pin: string | null, id: number) =>
      invoke<void>('requests:cancel', profileId, pin, id),
    listAll: (requestingProfileId: number) =>
      invoke<MediaRequest[]>('requests:listAll', requestingProfileId),
    pendingCount: (requestingProfileId: number) =>
      invoke<number>('requests:pendingCount', requestingProfileId),
    setStatus: (
      requestingProfileId: number,
      id: number,
      status: MediaRequestStatus,
      note: string | null
    ) => invoke<void>('requests:setStatus', requestingProfileId, id, status, note),
    remove: (requestingProfileId: number, id: number) =>
      invoke<void>('requests:delete', requestingProfileId, id)
  },
  dashboard: {
    history: (requestingProfileId: number, limit = 100) =>
      invoke<PlayHistoryEntry[]>('dashboard:history', requestingProfileId, limit),
    stats: (requestingProfileId: number, days: number) =>
      invoke<DashboardStats>('dashboard:stats', requestingProfileId, days),
    clearHistory: (requestingProfileId: number) =>
      invoke<void>('dashboard:clearHistory', requestingProfileId),
    setRetention: (requestingProfileId: number, days: number) =>
      invoke<void>('dashboard:setRetention', requestingProfileId, days),
    heartbeat: (
      profileId: number,
      mediaType: MediaType,
      mediaId: number,
      positionSeconds: number,
      state: 'playing' | 'paused' | 'buffering',
      channelId: number | null
    ) =>
      invoke<void>(
        'dashboard:heartbeat',
        profileId,
        mediaType,
        mediaId,
        positionSeconds,
        state,
        channelId
      ),
    snapshot: (requestingProfileId: number) =>
      invoke<DashboardSnapshot | null>('dashboard:snapshot', requestingProfileId),
    stopStream: (requestingProfileId: number, key: string, message: string) =>
      invoke<boolean>('dashboard:stopStream', requestingProfileId, key, message),
    setUploadCapacity: (requestingProfileId: number, mbps: number | null) =>
      invoke<void>('dashboard:setUploadCapacity', requestingProfileId, mbps)
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
    setTmdbKey: (key: string) => invoke<boolean>('settings:setTmdbKey', key),
    getTranscodeCacheDir: () =>
      invoke<{ path: string; isDefault: boolean }>('settings:getTranscodeCacheDir'),
    chooseTranscodeCacheDir: () => invoke<string | null>('settings:chooseTranscodeCacheDir'),
    resetTranscodeCacheDir: () => invoke<string>('settings:resetTranscodeCacheDir')
  },
  backups: {
    status: (requestingProfileId: number) => invoke<BackupStatus>('backups:status', requestingProfileId),
    backUpNow: (requestingProfileId: number) => invoke<BackupStatus>('backups:backUpNow', requestingProfileId),
    chooseCopyFolder: (requestingProfileId: number) =>
      invoke<BackupStatus>('backups:chooseCopyFolder', requestingProfileId),
    clearCopyFolder: (requestingProfileId: number) =>
      invoke<BackupStatus>('backups:clearCopyFolder', requestingProfileId),
    pickFromCopyFolder: (requestingProfileId: number) =>
      invoke<BackupInfo | null>('backups:pickFromCopyFolder', requestingProfileId),
    restore: (requestingProfileId: number, name: string) =>
      invoke<void>('backups:restore', requestingProfileId, name)
  },
  media: {
    serverPort: () => invoke<number>('media:serverPort')
  },
  system: {
    showInFolder: (path: string) => invoke<void>('system:showInFolder', path),
    openExternal: (url: string) => invoke<void>('system:openExternal', url)
  },
  updates: {
    getStatus: () => invoke<AppUpdateStatus>('updates:getStatus'),
    checkNow: () => invoke<void>('updates:checkNow'),
    installNow: () => invoke<void>('updates:installNow'),
    onStatus: (cb: (status: AppUpdateStatus) => void) => {
      const listener = (_e: unknown, status: AppUpdateStatus): void => cb(status)
      ipcRenderer.on('updates:status', listener)
      return () => {
        ipcRenderer.removeListener('updates:status', listener)
      }
    }
  },
  users: {
    listDevices: (requestingProfileId: number) =>
      invoke<UserDevice[]>('users:listDevices', requestingProfileId),
    createLoginCode: (requestingProfileId: number, profileId: number) =>
      invoke<LoginCodeResult>('users:createLoginCode', requestingProfileId, profileId),
    revokeDevice: (requestingProfileId: number, deviceId: number) =>
      invoke<void>('users:revokeDevice', requestingProfileId, deviceId),
    setDisabled: (requestingProfileId: number, profileId: number, disabled: boolean) =>
      invoke<void>('users:setDisabled', requestingProfileId, profileId, disabled)
  },
  remoteAccess: {
    getStatus: () => invoke<RemoteAccessStatus>('remoteAccess:getStatus'),
    serverCompatibility: () =>
      invoke<ServerCompatibility | null>('remoteAccess:serverCompatibility'),
    session: () => invoke<RemoteSession | null>('remoteAccess:session'),
    speedTest: () => invoke<SpeedTestResult>('remoteAccess:speedTest'),
    getRequireLogin: () => invoke<boolean>('remoteAccess:getRequireLogin'),
    checkPolicy: (requestingProfileId: number) =>
      invoke<TailnetPolicyCheck>('remoteAccess:checkPolicy', requestingProfileId),
    lockDownPolicy: (requestingProfileId: number) =>
      invoke<TailnetPolicyCheck>('remoteAccess:lockDownPolicy', requestingProfileId),
    setRequireLogin: (requestingProfileId: number, required: boolean) =>
      invoke<void>('remoteAccess:setRequireLogin', requestingProfileId, required),
    hasApiToken: () => invoke<boolean>('remoteAccess:hasApiToken'),
    saveApiToken: (token: string) => invoke<boolean>('remoteAccess:saveApiToken', token),
    removeApiToken: () => invoke<void>('remoteAccess:removeApiToken'),
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
