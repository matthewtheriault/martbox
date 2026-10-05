import type { RemoteAccessMode } from './remoteAccess'

export type MediaType = 'movie' | 'episode'

export interface Profile {
  id: number
  name: string
  avatarId: string
  createdAt: string
  isAdmin: boolean
  hasPin: boolean
  // A disabled user's devices are signed out and can't sign back in.
  disabled: boolean
  // When the profile's photo last changed (ms), or null for none: the
  // avatar is then avatarId's colour with the first letter. Also the
  // photo URL's cache-buster (/api/profiles/:id/avatar?v=…).
  avatarPhoto: number | null
}

// A device signed in as a user by redeeming a login code.
export interface UserDevice {
  id: number
  profileId: number
  name: string
  createdAt: string
  lastSeenAt: string | null
  // Latest speed test from this device to the host, if it has run one.
  speedMbps: number | null
  latencyMs: number | null
  speedTestedAt: string | null
}

export interface SpeedTestResult {
  mbps: number
  latencyMs: number
}

export interface LoginCodeResult {
  loginCode: string
  expiresAt: string
  // Full invite (Tailscale key + host + login code) for a brand-new device;
  // null when the host isn't sharing over Tailscale yet.
  invite: string | null
  inviteQrDataUrl: string | null
}

export interface CastMember {
  name: string
  character: string
  profilePath: string | null
}

export interface CrewMember {
  name: string
  job: string
}

export type MovieMetadataPatch = Partial<
  Pick<
    Movie,
    | 'title'
    | 'year'
    | 'overview'
    | 'posterPath'
    | 'backdropPath'
    | 'rating'
    | 'runtimeMinutes'
    | 'tmdbId'
    | 'genres'
    | 'collectionId'
    | 'collectionName'
    | 'collectionPosterPath'
    | 'cast'
    | 'crew'
    | 'trailerKey'
  >
>

export type ShowMetadataPatch = Partial<
  Pick<
    Show,
    | 'title'
    | 'year'
    | 'overview'
    | 'posterPath'
    | 'backdropPath'
    | 'rating'
    | 'tmdbId'
    | 'genres'
    | 'cast'
    | 'crew'
    | 'trailerKey'
  >
>

export interface MovieSearchResult {
  tmdbId: number
  title: string
  year: number | null
  overview: string
  posterPath: string | null
}

export interface ShowSearchResult {
  tmdbId: number
  title: string
  year: number | null
  overview: string
  posterPath: string | null
}

export interface Library {
  id: number
  path: string
  type: 'movie' | 'tv' | 'music'
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
  genres: string[]
  collectionId: number | null
  collectionName: string | null
  collectionPosterPath: string | null
  cast: CastMember[]
  crew: CrewMember[]
  trailerKey: string | null
  titleLocked: boolean
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
  genres: string[]
  addedAt: string
  cast: CastMember[]
  crew: CrewMember[]
  trailerKey: string | null
  titleLocked: boolean
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

export type AppUpdateState =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'downloading'
  | 'ready'
  | 'error'

export interface AppUpdateStatus {
  state: AppUpdateState
  currentVersion: string
  latestVersion: string | null
  releaseNotes: string | null
  progressPercent: number | null
  error: string | null
  checkedAt: string | null
}

export interface IptvChannel {
  id: number
  tvgId: string | null
  name: string
  logoUrl: string | null
  groupTitle: string | null
  sortOrder: number
  nowPlayingTitle: string | null
  nowPlayingStartsAt: string | null
  nowPlayingEndsAt: string | null
  nextProgrammeTitle: string | null
  nextProgrammeStartsAt: string | null
  isDead: boolean
  checkedAt: string | null
}

export interface IptvHealthSummary {
  total: number
  checked: number
  dead: number
  running: boolean
}

export interface IptvHealthProgress {
  current: number
  total: number
  dead: number
  done: boolean
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

export type WatchlistMediaType = 'movie' | 'show'

export interface WatchlistItem {
  mediaType: WatchlistMediaType
  mediaId: number
  addedAt: string
  title: string
  year: number | null
  posterPath: string | null
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

// --- Server dashboard (host app, admin only) ---

export type StreamState = 'playing' | 'paused' | 'buffering'

export interface DashboardStream {
  // Stable id for this stream, used to stop it.
  key: string
  deviceName: string
  profileName: string
  profileAvatarId: string | null
  mediaType: MediaType
  mediaId: number
  title: string
  // e.g. "S2 · E5 · The One With..." for episodes; the year for movies.
  subtitle: string
  posterPath: string | null
  positionSeconds: number
  durationSeconds: number | null
  state: StreamState
  // How it's being sent: see src/main/playback.ts. null = not known (an
  // older app, or playback on this PC).
  method: 'direct' | 'remux' | 'transcode' | null
  reason: string | null
  // Upload going to this stream right now.
  mbps: number
  // Times playback stalled to buffer in the last 5 minutes.
  recentStalls: number
  startedAt: number
  // Watched through a Live Channel: e.g. "5 · Movie Night".
  channel: string | null
  // The server's conversion for it (repackaging or converting), if any.
  conversion: {
    kind: 'transcode' | 'remux'
    height: number | null
    // Paused (far enough ahead of the viewer) or finished when false.
    running: boolean
    // × realtime; below 1 the viewer will buffer.
    speed: number | null
    fps: number | null
  } | null
}

export interface DashboardHardware {
  cpuModel: string
  cpuPercent: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  // e.g. "AMD AMF (h264_amf)" / "CPU (libx264)".
  encoder: string
  decoder: string
  conversionsRunning: number
  disks: { label: string; path: string; freeBytes: number; totalBytes: number }[]
}

export interface DashboardDevice {
  deviceId: number
  deviceName: string
  profileName: string
  // How traffic reaches it over Tailscale; null = unknown (no address
  // reported, or remote access is off).
  path: 'direct' | 'relayed' | 'idle' | null
  online: boolean | null
  speedMbps: number | null
  latencyMs: number | null
  speedTestedAt: string | null
  lastSeenAt: string | null
  // Sent to this device since midnight (or since MartBox started).
  bytesToday: number
  mbps: number
}

export interface DashboardSnapshot {
  streams: DashboardStream[]
  network: {
    // Total upload to remote devices, one point every 2 s over 5 minutes.
    samples: { t: number; mbps: number }[]
    currentMbps: number
    // What the admin says their internet upload is, for "18 of 500 Mbps".
    uploadCapacityMbps: number | null
    devices: DashboardDevice[]
  }
  hardware: DashboardHardware
  // Problems right now (and in the last hour), newest first.
  alerts: DashboardAlert[]
}

// --- Requests (friends ask for movies/shows; the admin handles them) ---

export type RequestMediaType = 'movie' | 'tv'

// A title from TMDB that someone could request. Image URLs point straight
// at TMDB's CDN (no key needed), so any app can show them.
export interface RequestableTitle {
  tmdbId: number
  mediaType: RequestMediaType
  title: string
  year: number | null
  overview: string
  posterUrl: string | null
  backdropUrl: string | null
  rating: number | null
  // Filled in by the server for browse and search results: whether it's
  // already on MartBox, and the newest open request for it.
  onServer?: boolean
  requestStatus?: MediaRequestStatus | null
}

export interface RequestDiscover {
  sections: { title: string; items: RequestableTitle[] }[]
}

export type MediaRequestStatus = 'pending' | 'approved' | 'declined' | 'available'

export interface MediaRequest {
  id: number
  tmdbId: number
  mediaType: RequestMediaType
  title: string
  year: number | null
  posterUrl: string | null
  // TV: the seasons asked for. null for movies, and for a show TMDB lists
  // no seasons for yet.
  seasons: number[] | null
  status: MediaRequestStatus
  // The admin's note (e.g. why it was declined).
  note: string | null
  profileId: number
  profileName: string
  createdAt: string
  updatedAt: string
  // Where it is in the library once available.
  libraryMovieId: number | null
  libraryShowId: number | null
}

export interface RequestTitleDetails extends RequestableTitle {
  genres: string[]
  runtimeMinutes: number | null
  // TV only: TMDB's seasons (specials, season 0, left out).
  seasons: { number: number; name: string; episodeCount: number; airYear: number | null }[]
  // Already on the server: the movie, or the show and which seasons.
  library: { movieId: number | null; showId: number | null; seasons: number[] } | null
  // Open requests for this title, from anyone.
  requests: MediaRequest[]
}

// --- Live Channels (always-on channels built from the library) ---

// What a channel plays: a show's episodes, or the movies matching a filter
// (all of them when no filter is set).
export type ChannelSource =
  | { kind: 'show'; showId: number }
  | { kind: 'movies'; genre?: string | null; decade?: number | null; collectionId?: number | null }

export interface ChannelConfig {
  name: string
  number: number
  sources: ChannelSource[]
  order: 'shuffle' | 'inOrder'
  // Caps the quality a channel streams at, so one left playing all day
  // doesn't send the original 4K the whole time.
  maxQuality: 'auto' | '1080' | '720' | '480'
  // Something else at set times of day ("cartoons 7–11 am"), local time.
  blocks?: ChannelBlock[]
  // Played between programs (shorts, bumpers, trailers kept as files).
  filler?: ChannelSource[]
  // An image in the server's image cache, shown in guides and as a corner
  // logo while watching.
  logoPath?: string | null
}

export interface ChannelBlock {
  // "HH:MM", 24-hour; an end at or before the start runs past midnight.
  start: string
  end: string
  sources: ChannelSource[]
  order: 'shuffle' | 'inOrder'
}

export interface Channel extends ChannelConfig {
  id: number
  itemCount: number
  // One full pass through everything the channel plays.
  cycleSeconds: number
}

export interface ChannelProgram {
  mediaType: MediaType
  mediaId: number
  title: string
  // e.g. "S2 · E5 · Title" for episodes, the year for movies.
  subtitle: string
  posterPath: string | null
  // Unix ms.
  start: number
  end: number
}

export interface ChannelNow {
  channel: Channel
  program: ChannelProgram
  // How far into the program it is right now.
  offsetSeconds: number
  next: ChannelProgram | null
}

export interface ChannelGuide {
  from: number
  to: number
  channels: { channel: Channel; programs: ChannelProgram[] }[]
}

// --- Dashboard v3: history, stats and alerts ---

export interface PlayHistoryEntry {
  id: number
  profileName: string
  deviceName: string
  mediaType: MediaType
  mediaId: number
  title: string
  subtitle: string
  method: 'direct' | 'remux' | 'transcode' | null
  channel: string | null
  // Unix ms.
  startedAt: number
  endedAt: number
  playingSeconds: number
}

export interface DashboardStats {
  days: number
  plays: number
  minutesWatched: number
  topTitles: { title: string; plays: number; minutes: number }[]
  byUser: { profileName: string; plays: number; minutes: number }[]
  peakStreams: number
  // Upload per day (oldest first), bytes.
  uploadByDay: { day: string; bytes: number }[]
  library: { movies: number; shows: number; episodes: number }
  retentionDays: number
}

export interface DashboardAlert {
  key: string
  level: 'warning' | 'problem'
  message: string
  // Unix ms, when it was last seen.
  at: number
}

// Where an episode's intro and end credits are (Skip Intro, Up Next), in
// seconds; null where nothing was found.
export interface EpisodeMarkers {
  introStart: number | null
  introEnd: number | null
  creditsStart: number | null
}

// A collection the admin made (collections.ts).
export interface CollectionItem {
  mediaType: 'movie' | 'show'
  id: number
  title: string
  year: number | null
  posterPath: string | null
  backdropPath: string | null
}

export interface Collection {
  id: number
  name: string
  description: string
  onHome: boolean
  items: CollectionItem[]
}

// Year in Review (watchLog.ts): one profile's watching in one year.
export interface YearInReviewTitle {
  mediaType: 'movie' | 'show'
  id: number
  title: string
  year: number | null
  posterPath: string | null
  seconds: number
}

export interface YearInReview {
  year: number
  // Every year this profile has anything for, newest first.
  years: number[]
  totalSeconds: number
  daysWatched: number
  moviesWatched: number
  episodesWatched: number
  showsWatched: number
  // Movies and episodes finished this year.
  finished: number
  topShows: YearInReviewTitle[]
  topMovies: YearInReviewTitle[]
  topGenres: { name: string; seconds: number }[]
  // January first; Sunday first.
  monthSeconds: number[]
  weekdaySeconds: number[]
  busiestDay: { day: string; seconds: number } | null
  longestStreak: number
  firstTitle: (YearInReviewTitle & { day: string }) | null
}

// Music (music.ts).
export interface MusicArtist {
  id: number
  name: string
  albumCount: number
  // An album whose cover stands for the artist.
  coverAlbumId: number | null
}

export interface MusicAlbum {
  id: number
  title: string
  artistId: number
  artist: string
  year: number | null
  trackCount: number
  durationSeconds: number
  hasCover: boolean
  // Every track lossless (FLAC, ALAC, WAV…).
  lossless: boolean
  sampleRate: number | null
  bitDepth: number | null
  addedAt: string
}

export interface MusicTrack {
  id: number
  title: string
  artist: string
  albumArtist: string
  albumId: number
  album: string
  trackNumber: number | null
  discNumber: number
  durationSeconds: number
  codec: string | null
  lossless: boolean
  sampleRate: number | null
  bitDepth: number | null
  bitrateKbps: number | null
  trackGain: number | null
  albumGain: number | null
  genre: string | null
  hasCover: boolean
}

export interface MusicAlbumDetail extends MusicAlbum {
  tracks: MusicTrack[]
}

export interface MusicSearchResults {
  artists: MusicArtist[]
  albums: MusicAlbum[]
  tracks: MusicTrack[]
}
