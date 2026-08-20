import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { basename } from 'path'
import { unlinkSync } from 'fs'
import * as repository from './repository'
import * as remoteClient from './remoteClient'
import { listLibraries, addLibrary, removeLibrary } from './repository'
import { getSetting, setSetting, encryptedGetSetting, encryptedSetSetting, backupDatabase } from './db'
import { logError } from './errorLog'
import {
  testApiKey,
  searchMovies,
  searchShows,
  fetchMovieByTmdbId,
  fetchShowByTmdbId,
  fetchRecommendedTmdbIds
} from './tmdb'
import {
  testApiToken,
  mintHostKey,
  mintGuestKey,
  listGuestDevices,
  revokeGuestDevice
} from './tailscaleApi'
import { scanAndMatchLibrary } from './library'
import { checkForUpdate, getUpdateCheckUrl, setUpdateCheckUrl } from './updateCheck'
import { verifyChannels, isHealthCheckRunning } from './iptvHealth'
import { refreshIptv } from './iptv'
import { getMediaServerPort } from './mediaServer'
import {
  startSidecar,
  stopSidecar,
  getLastRemoteAccessStatus,
  getSidecarLocalPort
} from './tsnetSidecar'
import {
  TSNET_FIXED_PORT,
  type InviteCode,
  type RemoteAccessMode,
  type RemoteAccessStatus
} from '../shared/remoteAccess'
import type {
  MediaType,
  MovieMetadataPatch,
  ShowMetadataPatch,
  WatchlistMediaType
} from '../shared/types'

// Picks the local DB (repository.ts) or, in client mode, the host's
// metadata HTTP API reached over the sidecar tunnel (remoteClient.ts).
// Library management and the TMDb key only ever make sense against the
// host's own DB, so those handlers below call repository.ts directly and
// are never routed through this.
function dataSource(): typeof repository | typeof remoteClient {
  return getSetting('remoteAccessMode') === 'client' ? remoteClient : repository
}

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('library:list', () => listLibraries())

  ipcMain.handle('library:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('library:add', (_e, path: string, type: 'movie' | 'tv') => {
    return addLibrary(path, type, basename(path))
  })

  ipcMain.handle('library:remove', (_e, id: number) => removeLibrary(id))

  ipcMain.handle('library:scan', async (_e, id: number) => {
    await backupDatabase()
    await scanAndMatchLibrary(id, (progress) => {
      mainWindow.webContents.send('library:scanProgress', progress)
    })
  })

  ipcMain.handle('movies:list', (_e, libraryId?: number) => dataSource().listMovies(libraryId))
  ipcMain.handle('movies:get', (_e, id: number) => dataSource().getMovie(id))

  // Manual metadata editing/re-matching only ever makes sense against the
  // host's own DB (same reasoning as library management above), so these
  // call repository.ts directly rather than going through dataSource().
  ipcMain.handle('movies:search', (_e, query: string) => searchMovies(query))
  ipcMain.handle('movies:applyMatch', async (_e, movieId: number, tmdbId: number) => {
    const match = await fetchMovieByTmdbId(tmdbId)
    if (!match) throw new Error('Could not fetch that title from TMDb')
    return repository.updateMovie(movieId, match)
  })
  ipcMain.handle('movies:update', (_e, id: number, patch: MovieMetadataPatch) =>
    repository.updateMovie(id, patch)
  )

  // Confirmation (including the "also delete the file" choice) lives in one
  // native dialog rather than custom renderer UI — more trustworthy for a
  // destructive, potentially-irreversible action, and no extra IPC round
  // trip needed for the checkbox state.
  ipcMain.handle('movies:delete', async (_e, id: number) => {
    const movie = repository.getMovie(id)
    if (!movie) return { deleted: false }
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Remove'],
      defaultId: 0,
      cancelId: 0,
      title: 'Remove from Library',
      message: `Remove "${movie.title}" from MartBox?`,
      detail:
        'This removes it from your library. Checking the box below also permanently deletes the file from disk — that part cannot be undone.',
      checkboxLabel: 'Also delete the file from disk',
      checkboxChecked: false
    })
    if (result.response !== 1) return { deleted: false }
    repository.deleteMovie(id)
    if (result.checkboxChecked) {
      try {
        unlinkSync(movie.filePath)
      } catch (err) {
        logError('movies:delete', err)
      }
    }
    return { deleted: true }
  })

  ipcMain.handle('shows:list', (_e, libraryId?: number) => dataSource().listShows(libraryId))
  ipcMain.handle('shows:get', (_e, id: number) => dataSource().getShow(id))
  ipcMain.handle('shows:episodes', (_e, showId: number) => dataSource().listEpisodes(showId))
  ipcMain.handle('shows:nextEpisode', (_e, profileId: number, showId: number) =>
    dataSource().getNextEpisodeToWatch(profileId, showId)
  )
  ipcMain.handle('episodes:get', (_e, id: number) => dataSource().getEpisode(id))

  ipcMain.handle('shows:search', (_e, query: string) => searchShows(query))
  ipcMain.handle('shows:applyMatch', async (_e, showId: number, tmdbId: number) => {
    const match = await fetchShowByTmdbId(tmdbId)
    if (!match) throw new Error('Could not fetch that title from TMDb')
    return repository.updateShow(showId, match)
  })
  ipcMain.handle('shows:update', (_e, id: number, patch: ShowMetadataPatch) =>
    repository.updateShow(id, patch)
  )
  ipcMain.handle('shows:merge', (_e, targetId: number, sourceIds: number[]) =>
    repository.mergeShows(targetId, sourceIds)
  )

  ipcMain.handle('shows:delete', async (_e, id: number) => {
    const show = repository.getShow(id)
    if (!show) return { deleted: false }
    const episodes = repository.listEpisodes(id)
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Remove'],
      defaultId: 0,
      cancelId: 0,
      title: 'Remove from Library',
      message: `Remove "${show.title}" from MartBox?`,
      detail:
        `This removes all ${episodes.length} episode(s) from your library. Checking the box below ` +
        'also permanently deletes those files from disk — that part cannot be undone.',
      checkboxLabel: 'Also delete the files from disk',
      checkboxChecked: false
    })
    if (result.response !== 1) return { deleted: false }
    repository.deleteShow(id)
    if (result.checkboxChecked) {
      for (const ep of episodes) {
        try {
          unlinkSync(ep.filePath)
        } catch (err) {
          logError('shows:delete', err)
        }
      }
    }
    return { deleted: true }
  })

  ipcMain.handle('search:library', (_e, query: string) => repository.searchLibrary(query))

  ipcMain.handle('movies:recommendations', async (_e, movieId: number) => {
    const movie = repository.getMovie(movieId)
    if (!movie?.tmdbId) return []
    const tmdbIds = await fetchRecommendedTmdbIds('movie', movie.tmdbId)
    return repository.getMoviesByTmdbIds(tmdbIds)
  })
  ipcMain.handle('shows:recommendations', async (_e, showId: number) => {
    const show = repository.getShow(showId)
    if (!show?.tmdbId) return []
    const tmdbIds = await fetchRecommendedTmdbIds('tv', show.tmdbId)
    return repository.getShowsByTmdbIds(tmdbIds)
  })
  ipcMain.handle('movies:collection', (_e, movieId: number) => {
    const movie = repository.getMovie(movieId)
    if (!movie?.collectionId) return []
    return repository.getMoviesInCollection(movie.collectionId, movieId)
  })

  ipcMain.handle('profiles:list', () => dataSource().listProfiles())
  ipcMain.handle('profiles:create', (_e, name: string, avatarId: string) =>
    dataSource().createProfile(name, avatarId)
  )
  ipcMain.handle('profiles:rename', (_e, id: number, name: string) =>
    dataSource().renameProfile(id, name)
  )
  ipcMain.handle('profiles:remove', (_e, id: number) => dataSource().deleteProfile(id))

  // The PIN itself always has to be checked against the host's real data —
  // but "always call repository.ts directly" (the previous approach) meant
  // a remote client checked its own empty local DB instead of the host's,
  // so PIN-protected profiles could never actually be unlocked remotely.
  // Explicit branching here (rather than dataSource()'s uniform interface)
  // since the requester/permission logic doesn't carry over cleanly.
  ipcMain.handle(
    'profiles:setPin',
    async (_e, requestingProfileId: number, targetProfileId: number, pin: string | null) => {
      const requester = (await dataSource().listProfiles()).find((p) => p.id === requestingProfileId)
      if (!requester) throw new Error('Unknown profile')
      if (requestingProfileId !== targetProfileId && !requester.isAdmin) {
        throw new Error("Only the admin can change another profile's PIN")
      }
      if (getSetting('remoteAccessMode') === 'client') {
        await remoteClient.setProfilePin(requestingProfileId, targetProfileId, pin)
      } else {
        repository.setProfilePin(targetProfileId, pin)
      }
    }
  )
  ipcMain.handle('profiles:verifyPin', async (_e, profileId: number, pin: string) => {
    if (getSetting('remoteAccessMode') === 'client') {
      return remoteClient.verifyProfilePin(profileId, pin)
    }
    return repository.verifyProfilePin(profileId, pin)
  })
  ipcMain.handle('profiles:listWithPins', (_e, requestingProfileId: number) => {
    const requester = repository.listProfiles().find((p) => p.id === requestingProfileId)
    if (!requester?.isAdmin) throw new Error('Only the admin can view PINs')
    return repository.listProfilesWithPins()
  })

  ipcMain.handle(
    'progress:save',
    (
      _e,
      profileId: number,
      mediaType: MediaType,
      mediaId: number,
      position: number,
      duration: number,
      pin?: string | null
    ) => dataSource().saveProgress(profileId, mediaType, mediaId, position, duration, pin)
  )
  ipcMain.handle(
    'progress:get',
    (_e, profileId: number, mediaType: MediaType, mediaId: number, pin?: string | null) =>
      dataSource().getProgress(profileId, mediaType, mediaId, pin)
  )
  ipcMain.handle(
    'progress:setWatched',
    (
      _e,
      profileId: number,
      mediaType: MediaType,
      mediaId: number,
      watched: boolean,
      pin?: string | null
    ) => dataSource().setWatched(profileId, mediaType, mediaId, watched, pin)
  )

  ipcMain.handle('continueWatching:list', (_e, profileId: number, pin?: string | null) =>
    dataSource().getContinueWatching(profileId, 20, pin)
  )

  ipcMain.handle('iptv:list', () => dataSource().listIptvChannels())

  ipcMain.handle('activity:list', () => dataSource().getAllActivity())

  ipcMain.handle('watchlist:list', (_e, profileId: number, pin?: string | null) =>
    dataSource().listWatchlist(profileId, pin)
  )
  ipcMain.handle(
    'watchlist:has',
    (_e, profileId: number, mediaType: WatchlistMediaType, mediaId: number, pin?: string | null) =>
      dataSource().isInWatchlist(profileId, mediaType, mediaId, pin)
  )
  ipcMain.handle(
    'watchlist:add',
    (_e, profileId: number, mediaType: WatchlistMediaType, mediaId: number, pin?: string | null) =>
      dataSource().addToWatchlist(profileId, mediaType, mediaId, pin)
  )
  ipcMain.handle(
    'watchlist:remove',
    (_e, profileId: number, mediaType: WatchlistMediaType, mediaId: number, pin?: string | null) =>
      dataSource().removeFromWatchlist(profileId, mediaType, mediaId, pin)
  )

  ipcMain.handle('library:getSeenAt', (_e, profileId: number, pin?: string | null) =>
    dataSource().getLibrarySeenAt(profileId, pin)
  )
  ipcMain.handle(
    'library:markSeen',
    (_e, profileId: number, mediaType: 'movie' | 'show', pin?: string | null) =>
      dataSource().markLibrarySeen(profileId, mediaType, pin)
  )

  ipcMain.handle('iptv:getSettings', () => ({
    m3uUrl: getSetting('iptvM3uUrl'),
    epgUrl: getSetting('iptvEpgUrl'),
    lastRefreshedAt: getSetting('iptvLastRefreshedAt'),
    lastError: getSetting('iptvLastError'),
    channelCount: repository.listIptvChannels().length
  }))

  const runHealthCheck = (): void => {
    void verifyChannels((progress) => {
      mainWindow.webContents.send('iptv:healthProgress', progress)
    })
  }

  ipcMain.handle('iptv:refresh', async (_e, m3uUrl: string, epgUrl: string) => {
    setSetting('iptvM3uUrl', m3uUrl)
    setSetting('iptvEpgUrl', epgUrl || '')
    try {
      const result = await refreshIptv(m3uUrl, epgUrl || null)
      // Fire-and-forget: a fresh playlist means every channel's health flag
      // was just wiped by the full-table replace, and the list is much more
      // useful with dead entries already flagged than making the user
      // remember to check manually.
      runHealthCheck()
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Refresh failed'
      setSetting('iptvLastError', message)
      return {
        channelCount: 0,
        programmeCount: 0,
        refreshedAt: getSetting('iptvLastRefreshedAt') ?? '',
        error: message
      }
    }
  })

  ipcMain.handle('iptv:verifyChannels', () => {
    runHealthCheck()
  })

  ipcMain.handle('iptv:getHealthSummary', () => ({
    ...repository.getIptvHealthSummary(),
    running: isHealthCheckRunning()
  }))

  ipcMain.handle('settings:get', () => ({
    tmdbApiKey: getSetting('tmdbApiKey'),
    remoteAccessMode: (getSetting('remoteAccessMode') ?? 'off') as RemoteAccessMode
  }))
  ipcMain.handle('settings:setTmdbKey', async (_e, key: string) => {
    const valid = await testApiKey(key)
    if (valid) setSetting('tmdbApiKey', key)
    return valid
  })

  ipcMain.handle('media:serverPort', () => {
    if (getSetting('remoteAccessMode') === 'client') return getSidecarLocalPort() ?? 0
    return getMediaServerPort()
  })

  // Host-only: a client has no local filesystem access to these paths at
  // all (they belong to the host's disk, not the client's), so the renderer
  // hides this action in client mode — this guard is the backstop in case
  // it's ever invoked anyway. shell.showItemInFolder runs entirely on this
  // machine, so even if called from a client build it could only ever
  // affect that machine's own (irrelevant) filesystem, never the host's.
  ipcMain.handle('system:showInFolder', (_e, path: string) => {
    if (getSetting('remoteAccessMode') === 'client') return
    shell.showItemInFolder(path)
  })

  ipcMain.handle('system:openExternal', (_e, url: string) => {
    if (!/^https:\/\//i.test(url)) return
    shell.openExternal(url)
  })

  // --- Update check (no publish infra yet, so this just compares against
  // a JSON manifest the user points at; the actual download opens in the
  // default browser rather than downloading/installing in-app) ---

  ipcMain.handle('updates:check', () => checkForUpdate())
  ipcMain.handle('updates:getCheckUrl', () => getUpdateCheckUrl())
  ipcMain.handle('updates:setCheckUrl', (_e, url: string) => setUpdateCheckUrl(url))
  ipcMain.handle('updates:openDownload', (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) return
    shell.openExternal(url)
  })

  // --- Remote access (Phase 2: Tailscale tsnet) ---

  const onStatus = (status: RemoteAccessStatus): void => {
    mainWindow.webContents.send('remoteAccess:status', status)
  }

  ipcMain.handle('remoteAccess:getStatus', () => getLastRemoteAccessStatus())

  ipcMain.handle('remoteAccess:saveApiToken', async (_e, token: string) => {
    const valid = await testApiToken(token)
    if (valid) encryptedSetSetting('tailscaleApiToken', token)
    return valid
  })

  ipcMain.handle('remoteAccess:hasApiToken', () => encryptedGetSetting('tailscaleApiToken') !== null)

  ipcMain.handle('remoteAccess:enableHost', async () => {
    const authKey = await mintHostKey()
    setSetting('remoteAccessMode', 'host')
    startSidecar({
      mode: 'host',
      authKey,
      forwardTo: `127.0.0.1:${getMediaServerPort()}`,
      onStatus: (status) => {
        if (status.tailscaleAddr) setSetting('remoteAccessHostAddr', status.tailscaleAddr)
        onStatus(status)
      }
    })
  })

  ipcMain.handle('remoteAccess:generateInvite', async () => {
    const authKey = await mintGuestKey()
    const hostAddr = getSetting('remoteAccessHostAddr')
    if (!hostAddr) throw new Error('Host is not connected yet — wait for it to finish connecting.')
    const invite: InviteCode = { v: 1, authKey, hostAddr, port: TSNET_FIXED_PORT }
    return Buffer.from(JSON.stringify(invite)).toString('base64')
  })

  // The invite key is single-use, but nothing else expires it — a joined
  // guest device stays in the tailnet indefinitely, so this is the only
  // in-app way to actually revoke access later.
  ipcMain.handle('remoteAccess:listGuests', () => listGuestDevices())
  ipcMain.handle('remoteAccess:revokeGuest', (_e, deviceId: string) => revokeGuestDevice(deviceId))

  ipcMain.handle('remoteAccess:connectClient', (_e, code: string) => {
    const invite = JSON.parse(Buffer.from(code, 'base64').toString('utf8')) as InviteCode
    setSetting('remoteAccessMode', 'client')
    setSetting('remoteAccessHostAddr', invite.hostAddr)
    startSidecar({
      mode: 'client',
      authKey: invite.authKey,
      hostAddr: `${invite.hostAddr}:${invite.port}`,
      onStatus
    })
  })

  ipcMain.handle('remoteAccess:disable', () => {
    stopSidecar()
    setSetting('remoteAccessMode', 'off')
  })
}
