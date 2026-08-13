import { getSidecarLocalPort } from './tsnetSidecar'
import type {
  ActivityItem,
  ContinueWatchingItem,
  Episode,
  IptvChannel,
  MediaType,
  Movie,
  Profile,
  Show,
  WatchProgress
} from '../shared/types'

// Same function names/signatures as repository.ts's read/write functions,
// but backed by the host's metadata HTTP API (mediaServer.ts) reached over
// the client sidecar's local forwarded port, instead of a local DB. ipc.ts
// picks between the two modules at call time based on remoteAccessMode.

function baseUrl(): string {
  const port = getSidecarLocalPort()
  if (!port) throw new Error('Not connected to a host yet')
  return `http://127.0.0.1:${port}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, init)
  if (!res.ok) throw new Error(`Host request failed: ${path} (${res.status})`)
  return (await res.json()) as T
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export function listProfiles(): Promise<Profile[]> {
  return request('/api/profiles')
}
export function createProfile(name: string, avatarId: string): Promise<Profile> {
  return request('/api/profiles', jsonInit('POST', { name, avatarId }))
}
export async function renameProfile(id: number, name: string): Promise<void> {
  await request(`/api/profiles/${id}`, jsonInit('PATCH', { name }))
}
export async function deleteProfile(id: number): Promise<void> {
  await request(`/api/profiles/${id}`, { method: 'DELETE' })
}

export function listMovies(libraryId?: number): Promise<Movie[]> {
  return request(`/api/movies${libraryId ? `?libraryId=${libraryId}` : ''}`)
}
export function getMovie(id: number): Promise<Movie | null> {
  return request(`/api/movies/${id}`)
}

export function listShows(libraryId?: number): Promise<Show[]> {
  return request(`/api/shows${libraryId ? `?libraryId=${libraryId}` : ''}`)
}
export function getShow(id: number): Promise<Show | null> {
  return request(`/api/shows/${id}`)
}
export function listEpisodes(showId: number): Promise<Episode[]> {
  return request(`/api/shows/${showId}/episodes`)
}
export function getEpisode(id: number): Promise<Episode | null> {
  return request(`/api/episodes/${id}`)
}
export function getNextEpisodeToWatch(profileId: number, showId: number): Promise<Episode | null> {
  return request(`/api/shows/${showId}/nextEpisode?profileId=${profileId}`)
}

export function getProgress(
  profileId: number,
  mediaType: MediaType,
  mediaId: number
): Promise<WatchProgress | null> {
  return request(`/api/progress?profileId=${profileId}&mediaType=${mediaType}&mediaId=${mediaId}`)
}
export async function saveProgress(
  profileId: number,
  mediaType: MediaType,
  mediaId: number,
  positionSeconds: number,
  durationSeconds: number
): Promise<void> {
  await request(
    '/api/progress',
    jsonInit('POST', { profileId, mediaType, mediaId, positionSeconds, durationSeconds })
  )
}
export async function setWatched(
  profileId: number,
  mediaType: MediaType,
  mediaId: number,
  watched: boolean
): Promise<void> {
  await request('/api/progress/watched', jsonInit('POST', { profileId, mediaType, mediaId, watched }))
}

export function getContinueWatching(profileId: number): Promise<ContinueWatchingItem[]> {
  return request(`/api/continueWatching?profileId=${profileId}`)
}

export function listIptvChannels(): Promise<IptvChannel[]> {
  return request('/api/iptv/channels')
}

export function getAllActivity(): Promise<ActivityItem[]> {
  return request('/api/activity')
}
