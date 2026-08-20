import { spawn, type ChildProcess } from 'child_process'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import type { RemoteAccessStatus } from '../shared/remoteAccess'

let child: ChildProcess | null = null
let currentLocalPort: number | null = null
let lastStatus: RemoteAccessStatus = { status: 'idle' }

export function getLastRemoteAccessStatus(): RemoteAccessStatus {
  return lastStatus
}

function resolveBinaryPath(): string {
  const isWin = process.platform === 'win32'
  const ext = isWin ? '.exe' : ''

  const packaged = join(process.resourcesPath, 'sidecar', `martbox-sidecar${ext}`)
  if (existsSync(packaged)) return packaged

  // Dev mode (electron-vite dev / unpackaged): resources/sidecar/<goos>-<goarch>/
  // built by `npm run build:sidecar`, resolved from this machine's platform/arch.
  const goos = isWin ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const goarch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  return join(app.getAppPath(), 'resources', 'sidecar', `${goos}-${goarch}`, `martbox-sidecar${ext}`)
}

export function getSidecarLocalPort(): number | null {
  return currentLocalPort
}

interface StartSidecarOptions {
  mode: 'host' | 'client'
  authKey?: string
  forwardTo?: string // host mode: local address to expose over the tailnet
  hostAddr?: string // client mode: host's tailnet address to connect to
  onStatus: (status: RemoteAccessStatus) => void
}

export function startSidecar(opts: StartSidecarOptions): void {
  stopSidecar()

  const binaryPath = resolveBinaryPath()
  const stateDir = join(app.getPath('userData'), 'tsnet-state', opts.mode)

  const args = ['--mode', opts.mode, '--state-dir', stateDir]
  if (opts.mode === 'host') {
    if (!opts.forwardTo) throw new Error('forwardTo is required in host mode')
    args.push('--forward-to', opts.forwardTo)
  } else {
    if (!opts.hostAddr) throw new Error('hostAddr is required in client mode')
    args.push('--host', opts.hostAddr)
  }

  const proc = spawn(binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  child = proc
  currentLocalPort = null

  // Auth key only needs to be sent once, on first enrollment — tsnet
  // persists node identity to --state-dir and reconnects without it on
  // subsequent launches. Always write a line (even empty) so the sidecar's
  // blocking stdin read never hangs.
  proc.stdin!.write(`${opts.authKey ?? ''}\n`)
  proc.stdin!.end()

  let buffer = ''
  proc.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      try {
        const status = JSON.parse(line) as RemoteAccessStatus
        if (status.localPort) currentLocalPort = status.localPort
        lastStatus = status
        opts.onStatus(status)
      } catch {
        // not a status line; ignore
      }
    }
  })

  proc.stderr!.on('data', (chunk: Buffer) => {
    console.error('[tsnet-sidecar]', chunk.toString('utf8').trim())
  })

  proc.on('exit', (code) => {
    if (child !== proc) return
    child = null
    currentLocalPort = null
    if (code !== 0 && code !== null) {
      opts.onStatus({ status: 'error', message: `sidecar exited with code ${code}` })
    }
  })
}

export function stopSidecar(): void {
  if (child) {
    child.kill()
    child = null
    currentLocalPort = null
  }
  lastStatus = { status: 'idle' }
}
