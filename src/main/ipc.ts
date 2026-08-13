import { ipcMain, dialog, BrowserWindow } from 'electron'
import { basename } from 'path'
import * as repository from './repository'
import * as remoteClient from './remoteClient'
import { listLibraries, addLibrary, removeLibrary } from './repository'
import { getSetting, setSetting, encryptedGetSetting, encryptedSetSetting } from './db'
import { testApiKey } from './tmdb'
import { testApiToken, mintHostKey, mintGuestKey } from './tailscaleApi'
import { scanAndMatchLibrary } from './library'
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
import type { MediaType } from '../shared/types'

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
    await scanAndMatchLibrary(id, (progress) => {
      mainWindow.webContents.send('library:scanProgress', progress)
    })
  })

  ipcMain.handle('movies:list', (_e, libraryId?: number) => dataSource().listMovies(libraryId))
  ipcMain.handle('movies:get', (_e, id: number) => dataSource().getMovie(id))

  ipcMain.handle('shows:list', (_e, libraryId?: number) => dataSource().listShows(libraryId))
  ipcMain.handle('shows:get', (_e, id: number) => dataSource().getShow(id))
  ipcMain.handle('shows:episodes', (_e, showId: number) => dataSource().listEpisodes(showId))
  ipcMain.handle('shows:nextEpisode', (_e, profileId: number, showId: number) =>
    dataSource().getNextEpisodeToWatch(profileId, showId)
  )
  ipcMain.handle('episodes:get', (_e, id: number) => dataSource().getEpisode(id))

  ipcMain.handle('profiles:list', () => dataSource().listProfiles())
  ipcMain.handle('profiles:create', (_e, name: string, avatarId: string) =>
    dataSource().createProfile(name, avatarId)
  )
  ipcMain.handle('profiles:rename', (_e, id: number, name: string) =>
    dataSource().renameProfile(id, name)
  )
  ipcMain.handle('profiles:remove', (_e, id: number) => dataSource().deleteProfile(id))

  ipcMain.handle(
    'progress:save',
    (
      _e,
      profileId: number,
      mediaType: MediaType,
      mediaId: number,
      position: number,
      duration: number
    ) => dataSource().saveProgress(profileId, mediaType, mediaId, position, duration)
  )
  ipcMain.handle('progress:get', (_e, profileId: number, mediaType: MediaType, mediaId: number) =>
    dataSource().getProgress(profileId, mediaType, mediaId)
  )
  ipcMain.handle(
    'progress:setWatched',
    (_e, profileId: number, mediaType: MediaType, mediaId: number, watched: boolean) =>
      dataSource().setWatched(profileId, mediaType, mediaId, watched)
  )

  ipcMain.handle('continueWatching:list', (_e, profileId: number) =>
    dataSource().getContinueWatching(profileId)
  )

  ipcMain.handle('iptv:list', () => dataSource().listIptvChannels())

  ipcMain.handle('activity:list', () => dataSource().getAllActivity())

  ipcMain.handle('iptv:getSettings', () => ({
    m3uUrl: getSetting('iptvM3uUrl'),
    epgUrl: getSetting('iptvEpgUrl'),
    lastRefreshedAt: getSetting('iptvLastRefreshedAt'),
    lastError: getSetting('iptvLastError'),
    channelCount: repository.listIptvChannels().length
  }))

  ipcMain.handle('iptv:refresh', async (_e, m3uUrl: string, epgUrl: string) => {
    setSetting('iptvM3uUrl', m3uUrl)
    setSetting('iptvEpgUrl', epgUrl || '')
    try {
      return await refreshIptv(m3uUrl, epgUrl || null)
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
