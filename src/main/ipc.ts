import { ipcMain, dialog, BrowserWindow } from 'electron'
import { basename } from 'path'
import {
  listLibraries,
  addLibrary,
  removeLibrary,
  listMovies,
  getMovie,
  listShows,
  getShow,
  listEpisodes,
  getEpisode,
  getNextEpisodeToWatch,
  saveProgress,
  getProgress,
  setWatched,
  getContinueWatching
} from './repository'
import { getSetting, setSetting } from './db'
import { testApiKey } from './tmdb'
import { scanAndMatchLibrary } from './library'
import { getMediaServerPort } from './mediaServer'
import type { MediaType } from '../shared/types'

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

  ipcMain.handle('movies:list', (_e, libraryId?: number) => listMovies(libraryId))
  ipcMain.handle('movies:get', (_e, id: number) => getMovie(id))

  ipcMain.handle('shows:list', (_e, libraryId?: number) => listShows(libraryId))
  ipcMain.handle('shows:get', (_e, id: number) => getShow(id))
  ipcMain.handle('shows:episodes', (_e, showId: number) => listEpisodes(showId))
  ipcMain.handle('shows:nextEpisode', (_e, showId: number) => getNextEpisodeToWatch(showId))
  ipcMain.handle('episodes:get', (_e, id: number) => getEpisode(id))

  ipcMain.handle(
    'progress:save',
    (_e, mediaType: MediaType, mediaId: number, position: number, duration: number) =>
      saveProgress(mediaType, mediaId, position, duration)
  )
  ipcMain.handle('progress:get', (_e, mediaType: MediaType, mediaId: number) =>
    getProgress(mediaType, mediaId)
  )
  ipcMain.handle(
    'progress:setWatched',
    (_e, mediaType: MediaType, mediaId: number, watched: boolean) =>
      setWatched(mediaType, mediaId, watched)
  )

  ipcMain.handle('continueWatching:list', () => getContinueWatching())

  ipcMain.handle('settings:get', () => ({ tmdbApiKey: getSetting('tmdbApiKey') }))
  ipcMain.handle('settings:setTmdbKey', async (_e, key: string) => {
    const valid = await testApiKey(key)
    if (valid) setSetting('tmdbApiKey', key)
    return valid
  })

  ipcMain.handle('media:serverPort', () => getMediaServerPort())
}
