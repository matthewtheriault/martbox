import './devUserData'
import { analyzeMarkersSoon } from './markers'
import { seedFromPlayHistory } from './watchLog'
import { app, BrowserWindow, shell, Tray, Menu, nativeImage, session } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc'
import { startMediaServer, getMediaServerRemotePort } from './mediaServer'
import { startSidecar, stopSidecar, getSidecarLocalPort } from './tsnetSidecar'
import { authHeaders, handleClientStatus } from './clientSession'
import { scheduleAutoSpeedTest } from './remoteClient'
import { getSetting } from './db'
import { logError } from './errorLog'
import { sweepOrphanedImages } from './imageCache'
import { getUpdateStatus, initAutoUpdates, installUpdateNow, onUpdateStatus } from './autoUpdate'
import type { RemoteAccessStatus } from '../shared/remoteAccess'
import './db'

// A packaged app has no visible console — without these, an error anywhere
// outside an explicit try/catch would either crash the whole app silently or
// vanish into the void with zero diagnostic trail. Logging and continuing is
// the safer default for a long-running media server: dropping every remote
// friend's connection over one bad request is worse than surviving it.
process.on('uncaughtException', (err) => logError('uncaughtException', err))
process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason))

const imageCacheDir = join(app.getPath('userData'), 'images-cache')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

// Nothing stops a user from double-launching MartBox (e.g. clicking the
// shortcut twice) — two instances would both try to bind a media server and
// open the same SQLite file concurrently. Bail out of the second one and
// just surface the window the first instance already has.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

function resolveIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
}

// A host usually lives in the tray for weeks, so a downloaded update also
// gets a tray item — the Settings page isn't the only way to install it.
function buildTrayMenu(): Menu {
  const update = getUpdateStatus()
  return Menu.buildFromTemplate([
    {
      label: 'Open MartBox',
      click: () => {
        mainWindow?.show()
      }
    },
    ...(update.state === 'ready'
      ? [
          { type: 'separator' as const },
          {
            label: `Restart to install MartBox ${update.latestVersion}`,
            click: () => {
              installUpdateNow()
            }
          }
        ]
      : []),
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit()
      }
    }
  ])
}

function createTray(): void {
  const icon = nativeImage.createFromPath(resolveIconPath()).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('MartBox')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', () => mainWindow?.show())
  onUpdateStatus(() => tray?.setContextMenu(buildTrayMenu()))
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#0b0b0f',
    autoHideMenuBar: true,
    icon: resolveIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Explicit, not just relying on Electron's default: the preload
      // script only touches contextBridge/ipcRenderer, no filesystem or
      // native module access, so there's no reason for the renderer
      // process to run outside the OS sandbox.
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // MartBox is a server for as long as it's running — closing the window
  // shouldn't quit the app (and drop remote friends' connections). Minimize
  // to the tray instead; only the tray's "Quit" item (or before-quit from
  // elsewhere) actually exits.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  await startMediaServer(imageCacheDir)
  // Finds intros and credits in TV episodes once the app has settled.
  analyzeMarkersSoon(60_000)
  seedFromPlayHistory()

  // MartBox can stay running for weeks at a time (closing the window only
  // hides to tray), so a startup-only sweep isn't enough on its own — also
  // re-check daily rather than requiring a restart to reclaim space.
  sweepOrphanedImages(imageCacheDir)
  setInterval(() => sweepOrphanedImages(imageCacheDir), 24 * 60 * 60 * 1000)

  registerIpcHandlers(mainWindow)

  const remoteAccessMode = getSetting('remoteAccessMode')
  const onStatus = (status: RemoteAccessStatus): void => {
    mainWindow?.webContents.send('remoteAccess:status', status)
    tray?.setToolTip(`MartBox — ${status.status}`)
  }
  if (remoteAccessMode === 'host') {
    startSidecar({ mode: 'host', forwardTo: `127.0.0.1:${getMediaServerRemotePort()}`, onStatus })
  } else if (remoteAccessMode === 'client') {
    const hostAddr = getSetting('remoteAccessHostAddr')
    if (hostAddr) {
      startSidecar({
        mode: 'client',
        hostAddr,
        onStatus: (status) => {
          onStatus(status)
          handleClientStatus(status).then((error) => {
            if (error) onStatus({ status: 'error', message: error })
            else if (status.status === 'connected') scheduleAutoSpeedTest()
          })
        }
      })
    }
  }

  // <video> and <img> requests to the host can't carry custom headers, so
  // in client mode the device key is added here for anything sent to the
  // sidecar's local port — the same key remoteClient.ts sends on API calls.
  // Trailers play in YouTube's embedded player, which refuses to start
  // without a referrer — and pages loaded from file:// send none.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['http://127.0.0.1/*', 'https://www.youtube-nocookie.com/embed/*'] },
    (details, callback) => {
      if (details.url.startsWith('https://www.youtube-nocookie.com/')) {
        callback({ requestHeaders: { ...details.requestHeaders, Referer: 'https://martbox.app/' } })
        return
      }
      const port = getSidecarLocalPort()
      if (port && getSetting('remoteAccessMode') === 'client' && new URL(details.url).port === String(port)) {
        callback({ requestHeaders: { ...details.requestHeaders, ...authHeaders() } })
        return
      }
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    // 'detach' pops DevTools into its own OS window instead of docking inside
    // mainWindow, so it's unmistakably visible instead of a panel that's easy
    // to miss (or gets squeezed out on a small/unfocused window).
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    await loadPackagedRendererWithRetry(mainWindow)
  }
}

// On a fresh/unsigned install, antivirus real-time scanning can briefly lock
// the just-written app.asar right as Electron tries to open index.html out
// of it, failing the load with ERR_FAILED and leaving mainWindow permanently
// black (nothing re-triggers loadFile on its own). That lock is transient —
// a short retry loop recovers instead of requiring the user to relaunch.
async function loadPackagedRendererWithRetry(win: BrowserWindow, maxAttempts = 5): Promise<void> {
  const filePath = join(__dirname, '../renderer/index.html')
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await win.loadFile(filePath)
      return
    } catch (err) {
      logError('loadPackagedRendererWithRetry', err)
      if (attempt === maxAttempts) throw err
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
}

app.whenReady().then(() => {
  createWindow()
  createTray()
  initAutoUpdates()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  stopSidecar()
})
