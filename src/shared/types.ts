import type { RemoteAccessMode } from './remoteAccess'

export type MediaType = 'movie' | 'episode'

export interface Profile {
  id: number
  name: string
  avatarId: string
  createdAt: string
  isAdmin: boolean
}

export interface Library {
  id: number
  path: string
  type: 'movie' | 'tv'
  name: string
}

export interface Movie {
  id: number
  libraryId: number
  filePath: string
  title: string
  sortTitle: string
  year: number | null
  tmdbId: number | null
  overview: string | null
  posterPath: string | null
  backdropPath: string | null
  rating: number | null
  runtimeMinutes: number | null
  addedAt: string
}

export interface Show {
  id: number
  libraryId: number
  folderPath: string
  title: string
  sortTitle: string
  year: number | null
  tmdbId: number | null
  overview: string | null
  posterPath: string | null
  backdropPath: string | null
  rating: number | null
}

export interface Episode {
  id: number
  showId: number
  seasonNumber: number
  episodeNumber: number
  filePath: string
  title: string
  overview: string | null
  stillPath: string | null
  airDate: string | null
  durationSeconds: number | null
}

export interface WatchProgress {
  profileId: number
  mediaType: MediaType
  mediaId: number
  positionSeconds: number
  durationSeconds: number
  watched: boolean
  updatedAt: string
}

export interface ContinueWatchingItem {
  mediaType: MediaType
  mediaId: number
  positionSeconds: number
  durationSeconds: number
  updatedAt: string
  title: string
  subtitle: string | null
  posterPath: string | null
  backdropPath: string | null
  showId: number | null
  seasonNumber: number | null
  episodeNumber: number | null
}

export interface ScanProgress {
  libraryId: number
  phase: 'scanning' | 'matching' | 'done' | 'error'
  current: number
  total: number
  message: string
}

export interface AppSettings {
  tmdbApiKey: string | null
  remoteAccessMode: RemoteAccessMode
}

export interface IptvChannel {
  id: number
  tvgId: string | null
  name: string
  logoUrl: string | null
  groupTitle: string | null
  sortOrder: number
  nowPlayingTitle: string | null
  nowPlayingEndsAt: string | null
}

export interface IptvSettingsInfo {
  m3uUrl: string | null
  epgUrl: string | null
  lastRefreshedAt: string | null
  lastError: string | null
  channelCount: number
}

export interface IptvRefreshResult {
  channelCount: number
  programmeCount: number
  refreshedAt: string
  error: string | null
}

export interface ActivityItem {
  profileId: number
  profileName: string
  profileAvatarId: string
  mediaType: MediaType
  mediaId: number
  positionSeconds: number
  durationSeconds: number
  watched: boolean
  updatedAt: string
  title: string
  subtitle: string | null
  posterPath: string | null
  backdropPath: string | null
}
