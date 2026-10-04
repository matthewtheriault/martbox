import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { basename } from 'path'
import { unlinkSync } from 'fs'
import * as repository from './repository'
import * as remoteClient from './remoteClient'
import { listLibraries, addLibrary, removeLibrary } from './repository'
import {
  getSetting,
  setSetting,
  deleteSetting,
  encryptedGetSetting,
  encryptedSetSetting,
  backupDatabase
} from './db'
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
  revokeGuestDevice,
  revokeGuestDevicesByAddr,
  getTailnetPolicy,
  setTailnetPolicy
} from './tailscaleApi'
import { checkPolicy, recommendedPolicy } from './tailnetPolicy'
import QRCode from 'qrcode'
import {
  createLoginCode,
  deviceAddrsForProfile,
  listDevices,
  revokeDevice,
  setUserDisabled
} from './auth'
import { looksLikeLoginCode } from './authCore'
import { handleClientStatus, redeemLoginCode, setPendingLoginCode } from './clientSession'
import { scanAndMatchLibrary } from './library'
import { deleteChannel, listChannels, rebuildAllChannels, saveChannel } from './channels'
import { clearHistory, historyStats, listHistory, setRetentionDays } from './history'
import {
  deleteRequest,
  listRequests,
  pendingRequestCount,
  setRequestStatus
} from './requests'
import {
  checkForUpdatesNow,
  getUpdateStatus,
  installUpdateNow,
  onUpdateStatus
} from './autoUpdate'
import { verifyChannels, isHealthCheckRunning } from './iptvHealth'
import { refreshIptv } from './iptv'
import {
  DEFAULT_HLS_CACHE_DIR,
  dashboardSnapshot,
  getMediaServerPort,
  getMediaServerRemotePort,
  hlsCacheDir,
  isRemoteLoginRequired,
  noteLocalPlayback,
  setHlsCacheDir,
  setUploadCapacityMbps,
  stopDashboardStream
} from './mediaServer'
import {
  startSidecar,
  stopSidecar,
  getLastRemoteAccessStatus,
  getSidecarLocalPort
} from './tsnetSidecar'
import {
  API_VERSION,
  TSNET_FIXED_PORT,
  type InviteCode,
  type InviteCodeV2,
  type RemoteAccessMode,
  type RemoteAccessStatus,
  type ServerCompatibility
} from '../shared/remoteAccess'
import type {
  ChannelConfig,
  ChannelGuide,
  ChannelNow,
  LoginCodeResult,
  MediaRequest,
  MediaRequestStatus,
  MediaType,
  MovieMetadataPatch,
  RequestDiscover,
  RequestMediaType,
  RequestTitleDetails,
  RequestableTitle,
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
    // New episodes and movies join their Live Channels.
    void rebuildAllChannels()
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
  ipcMain.handle('profiles:remove', async (_e, id: number) => {
    // Deleting a user on the host cascades to their devices; take their
    // tailnet devices with them so a deleted friend can't still reach the
    // server.
    const addrs = getSetting('remoteAccessMode') === 'client' ? [] : deviceAddrsForProfile(id)
    await dataSource().deleteProfile(id)
    await revokeGuestDevicesByAddr(addrs).catch((err) => logError('revokeGuestDevicesByAddr', err))
  })

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
    ) => {
      // Playback on this PC shows on the dashboard as "This PC".
      if (getSetting('remoteAccessMode') !== 'client') {
        noteLocalPlayback(profileId, mediaType, mediaId, position)
      }
      return dataSource().saveProgress(profileId, mediaType, mediaId, position, duration, pin)
    }
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

  // Live TV/IPTV is hidden on Mac App Store builds only — see the matching
  // comment in mediaServer.ts. process.mas is set automatically by Electron.
  if (!process.mas) {
    ipcMain.handle('iptv:list', () => dataSource().listIptvChannels())
  }

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

  if (!process.mas) {
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
  }

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

  // --- In-app updates (electron-updater + GitHub Releases, autoUpdate.ts) ---

  ipcMain.handle('updates:getStatus', () => getUpdateStatus())
  ipcMain.handle('updates:checkNow', () => checkForUpdatesNow())
  ipcMain.handle('updates:installNow', () => installUpdateNow())
  onUpdateStatus((status) => mainWindow.webContents.send('updates:status', status))

  // --- Server/app compatibility (client mode only) ---

  ipcMain.handle('remoteAccess:serverCompatibility', async (): Promise<ServerCompatibility | null> => {
    if (getSetting('remoteAccessMode') !== 'client') return null
    const server = await remoteClient.getServerVersion()
    const serverApi = server?.apiVersion ?? 0
    return {
      server,
      clientApiVersion: API_VERSION,
      compatible: serverApi === API_VERSION,
      needsUpdate: serverApi < API_VERSION ? 'server' : serverApi > API_VERSION ? 'app' : null
    }
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

  // Settings.tsx hides the token input once a token is saved, with no other
  // path to replace a revoked/rotated one — this is that path.
  ipcMain.handle('remoteAccess:removeApiToken', () => deleteSetting('tailscaleApiToken'))

  ipcMain.handle('remoteAccess:enableHost', async () => {
    const authKey = await mintHostKey()
    setSetting('remoteAccessMode', 'host')
    startSidecar({
      mode: 'host',
      authKey,
      forwardTo: `127.0.0.1:${getMediaServerRemotePort()}`,
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

  const onClientStatus = (status: RemoteAccessStatus): void => {
    onStatus(status)
    handleClientStatus(status).then((error) => {
      if (error) onStatus({ status: 'error', message: error })
      else if (status.status === 'connected') remoteClient.scheduleAutoSpeedTest()
    })
  }

  // A full test (up to 64 MB / 6 s) when the user asks for one.
  ipcMain.handle('remoteAccess:speedTest', () => {
    if (getSetting('remoteAccessMode') !== 'client') throw new Error('Not connected to a server')
    return remoteClient.runSpeedTest(64 * 1024 * 1024, 6000)
  })

  // Accepts a full invite (v1: Tailscale only; v2: Tailscale + login code)
  // or, once already connected, a bare login code to sign this device in.
  ipcMain.handle('remoteAccess:connectClient', async (_e, code: string) => {
    const trimmed = code.trim()
    if (looksLikeLoginCode(trimmed)) {
      if (getSetting('remoteAccessMode') !== 'client' || !getSidecarLocalPort()) {
        throw new Error('Paste the full invite first — a login code on its own only works once connected.')
      }
      await redeemLoginCode(trimmed)
      return
    }
    let invite: InviteCode | InviteCodeV2
    try {
      invite = JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'))
    } catch {
      throw new Error("That doesn't look like a MartBox invite or login code.")
    }
    const tailscale = invite.v === 2 ? invite.tailscale : invite
    if (!tailscale?.authKey || !tailscale.hostAddr) {
      throw new Error("That doesn't look like a MartBox invite or login code.")
    }
    if (invite.v === 2) setPendingLoginCode(invite.loginCode)
    setSetting('remoteAccessMode', 'client')
    setSetting('remoteAccessHostAddr', tailscale.hostAddr)
    startSidecar({
      mode: 'client',
      authKey: tailscale.authKey,
      hostAddr: `${tailscale.hostAddr}:${tailscale.port}`,
      onStatus: onClientStatus
    })
  })

  ipcMain.handle('remoteAccess:session', () =>
    getSetting('remoteAccessMode') === 'client' ? remoteClient.getSession() : null
  )

  // --- Users (host only, admin only): login codes, devices, disabling ---

  const requireHostAdmin = (requestingProfileId: number): void => {
    if (getSetting('remoteAccessMode') === 'client') {
      throw new Error('Users are managed on the server.')
    }
    const requester = repository.listProfiles().find((p) => p.id === requestingProfileId)
    if (!requester?.isAdmin) throw new Error('Only the admin can manage users')
  }

  // --- Requests ---
  // The friend side works the same here as on the phone apps: through the
  // server's HTTP API — this PC's own server, or the host's in client mode.

  const serverCall = async (
    path: string,
    init?: RequestInit
  ): Promise<{ status: number; body: any }> => {
    if (getSetting('remoteAccessMode') === 'client') return remoteClient.rawRequest(path, init)
    const res = await fetch(`http://127.0.0.1:${getMediaServerPort()}${path}`, init)
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const okOrThrow = <T>(reply: { status: number; body: any }): T => {
    if (reply.status >= 200 && reply.status < 300) return reply.body as T
    throw new Error(reply.body?.error ?? `Request failed (${reply.status})`)
  }
  const profileQuery = (profileId: number, pin?: string | null): string =>
    `profileId=${profileId}${pin ? `&pin=${encodeURIComponent(pin)}` : ''}`

  ipcMain.handle('requests:discover', async () =>
    okOrThrow<RequestDiscover>(await serverCall('/api/requests/discover'))
  )
  ipcMain.handle('requests:search', async (_e, query: string) =>
    okOrThrow<RequestableTitle[]>(
      await serverCall(`/api/requests/search?q=${encodeURIComponent(query)}`)
    )
  )
  ipcMain.handle('requests:title', async (_e, mediaType: RequestMediaType, tmdbId: number) =>
    okOrThrow<RequestTitleDetails>(
      await serverCall(`/api/requests/title/${mediaType}/${tmdbId}`)
    )
  )
  ipcMain.handle('requests:mine', async (_e, profileId: number, pin?: string | null) =>
    okOrThrow<MediaRequest[]>(await serverCall(`/api/requests?${profileQuery(profileId, pin)}`))
  )
  // Resolves to the new request, or the reason it wasn't made.
  ipcMain.handle(
    'requests:create',
    async (
      _e,
      profileId: number,
      pin: string | null,
      mediaType: RequestMediaType,
      tmdbId: number,
      seasons: number[] | null
    ) => {
      const reply = await serverCall('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, pin, mediaType, tmdbId, seasons })
      })
      if (reply.status === 409) {
        return { ok: false, reason: reply.body?.error, by: reply.body?.by ?? null }
      }
      return { ok: true, request: okOrThrow<MediaRequest>(reply) }
    }
  )
  ipcMain.handle(
    'requests:cancel',
    async (_e, profileId: number, pin: string | null, id: number) => {
      await serverCall(`/api/requests/${id}?${profileQuery(profileId, pin)}`, { method: 'DELETE' })
    }
  )

  // --- Live Channels ---

  ipcMain.handle('channels:guide', async (_e, from: number, to: number) =>
    okOrThrow<ChannelGuide>(await serverCall(`/api/channels/guide?from=${from}&to=${to}`))
  )
  ipcMain.handle('channels:now', async (_e, id: number) =>
    okOrThrow<ChannelNow>(await serverCall(`/api/channels/${id}/now`))
  )
  // Building channels is the admin's, on the server PC.
  ipcMain.handle('channels:list', (_e, requestingProfileId: number) => {
    requireHostAdmin(requestingProfileId)
    return listChannels()
  })
  ipcMain.handle(
    'channels:save',
    (_e, requestingProfileId: number, id: number | null, config: ChannelConfig) => {
      requireHostAdmin(requestingProfileId)
      return saveChannel(id, config)
    }
  )
  ipcMain.handle('channels:delete', (_e, requestingProfileId: number, id: number) => {
    requireHostAdmin(requestingProfileId)
    deleteChannel(id)
  })

  // Admin, on the server PC.
  ipcMain.handle('requests:listAll', (_e, requestingProfileId: number) => {
    requireHostAdmin(requestingProfileId)
    return listRequests()
  })
  ipcMain.handle('requests:pendingCount', (_e, requestingProfileId: number) => {
    if (getSetting('remoteAccessMode') === 'client') return 0
    requireHostAdmin(requestingProfileId)
    return pendingRequestCount()
  })
  ipcMain.handle(
    'requests:setStatus',
    (
      _e,
      requestingProfileId: number,
      id: number,
      status: MediaRequestStatus,
      note: string | null
    ) => {
      requireHostAdmin(requestingProfileId)
      setRequestStatus(id, status, note)
    }
  )
  ipcMain.handle('requests:delete', (_e, requestingProfileId: number, id: number) => {
    requireHostAdmin(requestingProfileId)
    deleteRequest(id)
  })

  // The desktop's channel player reports what it's showing, like the apps'
  // heartbeat: straight to the dashboard here, or to the host in client mode.
  ipcMain.handle(
    'dashboard:heartbeat',
    async (
      _e,
      profileId: number,
      mediaType: MediaType,
      mediaId: number,
      positionSeconds: number,
      state: 'playing' | 'paused' | 'buffering',
      channelId: number | null
    ) => {
      if (getSetting('remoteAccessMode') !== 'client') {
        noteLocalPlayback(profileId, mediaType, mediaId, positionSeconds, state, channelId)
        return
      }
      await remoteClient
        .rawRequest('/api/playback/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mediaType, mediaId, positionSeconds, state, channelId })
        })
        .catch(() => {})
    }
  )

  // --- Dashboard (host only, admin only) ---

  // null in client mode: the dashboard lives on the server.
  ipcMain.handle('dashboard:snapshot', (_e, requestingProfileId: number) => {
    if (getSetting('remoteAccessMode') === 'client') return null
    requireHostAdmin(requestingProfileId)
    return dashboardSnapshot()
  })
  ipcMain.handle('dashboard:history', (_e, requestingProfileId: number, limit: number) => {
    requireHostAdmin(requestingProfileId)
    return listHistory(limit)
  })
  ipcMain.handle('dashboard:stats', (_e, requestingProfileId: number, days: number) => {
    requireHostAdmin(requestingProfileId)
    return historyStats(days === 7 || days === 30 || days === 90 ? days : 30)
  })
  ipcMain.handle('dashboard:clearHistory', (_e, requestingProfileId: number) => {
    requireHostAdmin(requestingProfileId)
    clearHistory()
  })
  ipcMain.handle('dashboard:setRetention', (_e, requestingProfileId: number, days: number) => {
    requireHostAdmin(requestingProfileId)
    setRetentionDays(days)
  })
  ipcMain.handle(
    'dashboard:stopStream',
    (_e, requestingProfileId: number, key: string, message: string) => {
      requireHostAdmin(requestingProfileId)
      return stopDashboardStream(key, message)
    }
  )
  ipcMain.handle(
    'dashboard:setUploadCapacity',
    (_e, requestingProfileId: number, mbps: number | null) => {
      requireHostAdmin(requestingProfileId)
      setUploadCapacityMbps(mbps)
    }
  )

  ipcMain.handle('users:listDevices', (_e, requestingProfileId: number) => {
    requireHostAdmin(requestingProfileId)
    return listDevices()
  })

  ipcMain.handle(
    'users:createLoginCode',
    async (_e, requestingProfileId: number, profileId: number): Promise<LoginCodeResult> => {
      requireHostAdmin(requestingProfileId)
      const { loginCode, expiresAt } = createLoginCode(profileId)
      // A full invite also lets a brand-new device join the tailnet — only
      // possible while sharing over Tailscale with an API token saved.
      let invite: string | null = null
      const hostAddr = getSetting('remoteAccessHostAddr')
      if (
        getSetting('remoteAccessMode') === 'host' &&
        hostAddr &&
        encryptedGetSetting('tailscaleApiToken') !== null
      ) {
        const admin = repository.listProfiles().find((p) => p.isAdmin)
        const v2: InviteCodeV2 = {
          v: 2,
          name: admin ? `${admin.name}'s MartBox` : 'MartBox',
          loginCode,
          tailscale: { authKey: await mintGuestKey(), hostAddr, port: TSNET_FIXED_PORT }
        }
        invite = Buffer.from(JSON.stringify(v2)).toString('base64')
      }
      const inviteQrDataUrl = invite
        ? await QRCode.toDataURL(invite, { errorCorrectionLevel: 'M', margin: 1, width: 320 })
        : null
      return { loginCode, expiresAt, invite, inviteQrDataUrl }
    }
  )

  ipcMain.handle('users:revokeDevice', async (_e, requestingProfileId: number, deviceId: number) => {
    requireHostAdmin(requestingProfileId)
    const addr = revokeDevice(deviceId)
    if (addr) await revokeGuestDevicesByAddr([addr]).catch((err) => logError('revokeGuestDevicesByAddr', err))
  })

  ipcMain.handle(
    'users:setDisabled',
    async (_e, requestingProfileId: number, profileId: number, disabled: boolean) => {
      requireHostAdmin(requestingProfileId)
      const addrs = setUserDisabled(profileId, disabled)
      await revokeGuestDevicesByAddr(addrs).catch((err) => logError('revokeGuestDevicesByAddr', err))
    }
  )

  // Where converted-video chunks are written while streaming (HLS).
  ipcMain.handle('settings:getTranscodeCacheDir', () => ({
    path: hlsCacheDir(),
    isDefault: hlsCacheDir() === DEFAULT_HLS_CACHE_DIR
  }))
  ipcMain.handle('settings:chooseTranscodeCacheDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder for temporary streaming files',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    setHlsCacheDir(result.filePaths[0])
    return hlsCacheDir()
  })
  ipcMain.handle('settings:resetTranscodeCacheDir', () => {
    setHlsCacheDir(null)
    return hlsCacheDir()
  })

  ipcMain.handle('remoteAccess:getRequireLogin', () => isRemoteLoginRequired())
  ipcMain.handle('remoteAccess:setRequireLogin', (_e, requestingProfileId: number, required: boolean) => {
    requireHostAdmin(requestingProfileId)
    setSetting('remoteRequireLogin', required ? '1' : '0')
  })

  // --- Tailnet access rules (who can reach what over Tailscale) ---

  ipcMain.handle('remoteAccess:checkPolicy', async (_e, requestingProfileId: number) => {
    requireHostAdmin(requestingProfileId)
    const { policy } = await getTailnetPolicy()
    return checkPolicy(policy)
  })

  ipcMain.handle('remoteAccess:lockDownPolicy', async (_e, requestingProfileId: number) => {
    requireHostAdmin(requestingProfileId)
    const { policy, etag } = await getTailnetPolicy()
    await setTailnetPolicy(recommendedPolicy(policy), etag)
    return checkPolicy((await getTailnetPolicy()).policy)
  })

  ipcMain.handle('remoteAccess:disable', () => {
    stopSidecar()
    setSetting('remoteAccessMode', 'off')
  })
}
