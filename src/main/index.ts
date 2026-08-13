import { app, BrowserWindow, shell, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc'
import { startMediaServer, getMediaServerPort } from './mediaServer'
import { startSidecar, stopSidecar } from './tsnetSidecar'
import { getSetting } from './db'
import type { RemoteAccessStatus } from '../shared/remoteAccess'
import './db'

const imageCacheDir = join(app.getPath('userData'), 'cache', 'images')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function resolveIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
}

function createTray(): void {
  const icon = nativeImage.createFromPath(resolveIconPath()).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('MartBox')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open MartBox',
        click: () => {
          mainWindow?.show()
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => mainWindow?.show())
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
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
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

  registerIpcHandlers(mainWindow)

  const remoteAccessMode = getSetting('remoteAccessMode')
  const onStatus = (status: RemoteAccessStatus): void => {
    mainWindow?.webContents.send('remoteAccess:status', status)
    tray?.setToolTip(`MartBox — ${status.status}`)
  }
  if (remoteAccessMode === 'host') {
    startSidecar({ mode: 'host', forwardTo: `127.0.0.1:${getMediaServerPort()}`, onStatus })
  } else if (remoteAccessMode === 'client') {
    const hostAddr = getSetting('remoteAccessHostAddr')
    if (hostAddr) startSidecar({ mode: 'client', hostAddr, onStatus })
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  createTray()

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
