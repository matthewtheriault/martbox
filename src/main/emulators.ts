import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { gunzipSync } from 'zlib'
import { dirname, join } from 'path'
import { SYSTEMS } from './gamesCore'
import type { EmulatorStatus } from '../shared/types'

// The emulators (EmulatorJS: libretro cores built for the web). MartBox
// ships none of them: when the owner turns games on, the server downloads
// one pinned version from npm, checks each package against npm's checksum,
// and serves the files to every device from /emulator/.

export const EMULATOR_VERSION = '4.2.3'
const REGISTRY = 'https://registry.npmjs.org'

export function emulatorDir(): string {
  return join(app.getPath('userData'), 'emulators', EMULATOR_VERSION)
}

let status: EmulatorStatus = { state: 'missing', version: EMULATOR_VERSION, progress: 0, message: null }

export function emulatorStatus(): EmulatorStatus {
  if (status.state !== 'downloading') {
    status = existsSync(join(emulatorDir(), 'ready.json')) ? { ...status, state: 'ready', progress: 1, message: null } : status
  }
  return status
}

// --- A .tgz from npm, read without a tar library (ustar: 512-byte headers)

export function untar(tgz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(tgz)
  const files = new Map<string, Buffer>()
  let pos = 0
  let longName: string | null = null
  while (pos + 512 <= tar.length) {
    const header = tar.subarray(pos, pos + 512)
    if (header.every((b) => b === 0)) break
    const field = (start: number, length: number): string => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1)
    const prefix = field(345, 155)
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = null
    const body = tar.subarray(pos + 512, pos + 512 + size)
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '')
    else if (type === '0' || type === '') files.set(name, Buffer.from(body))
    pos += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

async function fetchPackage(name: string): Promise<Map<string, Buffer>> {
  const meta = (await (await fetch(`${REGISTRY}/${name.replace('/', '%2f')}/${EMULATOR_VERSION}`)).json()) as {
    dist?: { tarball?: string; integrity?: string }
  }
  const { tarball, integrity } = meta.dist ?? {}
  if (!tarball || !integrity?.startsWith('sha512-')) throw new Error(`${name}: no download listed`)
  const res = await fetch(tarball)
  if (!res.ok) throw new Error(`${name}: download failed (${res.status})`)
  const data = Buffer.from(await res.arrayBuffer())
  if (createHash('sha512').update(data).digest('base64') !== integrity.slice('sha512-'.length)) {
    throw new Error(`${name}: checksum mismatch`)
  }
  return untar(data)
}

// The scripts the loader would fetch one by one, in its order, joined into
// the single file it looks for first.
const SCRIPTS = ['emulator.js', 'nipplejs.js', 'shaders.js', 'storage.js', 'gamepad.js', 'GameManager.js', 'socket.io.min.js', 'compression.js']

let running: Promise<void> | null = null

export function installEmulators(): Promise<void> {
  if (emulatorStatus().state === 'ready') return Promise.resolve()
  running ??= install().finally(() => (running = null))
  return running
}

async function install(): Promise<void> {
  const cores = [...new Set(SYSTEMS.map((s) => s.core))]
  const packages = ['@emulatorjs/emulatorjs', ...cores.map((c) => `@emulatorjs/core-${c}`)]
  const final = emulatorDir()
  const temp = `${final}.part`
  rmSync(temp, { recursive: true, force: true })
  const put = (path: string, data: Buffer | string): void => {
    mkdirSync(dirname(join(temp, path)), { recursive: true })
    writeFileSync(join(temp, path), data)
  }
  try {
    for (const [i, name] of packages.entries()) {
      status = { state: 'downloading', version: EMULATOR_VERSION, progress: i / packages.length, message: `Downloading ${name.replace('@emulatorjs/', '')}…` }
      const files = await fetchPackage(name)
      if (name === '@emulatorjs/emulatorjs') {
        const data = (path: string): Buffer => {
          const f = files.get(`package/data/${path}`)
          if (!f) throw new Error(`EmulatorJS is missing ${path}`)
          return f
        }
        put('loader.js', data('loader.js'))
        put('emulator.min.js', SCRIPTS.map((s) => data(`src/${s}`).toString('utf8')).join(';\n'))
        put('emulator.min.css', data('emulator.css'))
        for (const [path, body] of files) {
          const m = /^package\/data\/((?:compression|localization)\/.+)$/.exec(path)
          if (m) put(m[1], body)
        }
        put('LICENSE', files.get('package/LICENSE') ?? '')
      } else {
        // The plain and legacy builds; the threaded ones need page isolation the apps don't use.
        for (const [path, body] of files) {
          const m = /^package\/(([a-z0-9_]+)(-legacy)?-wasm\.data|reports\/[a-z0-9_]+\.json)$/.exec(path)
          if (m) put(`cores/${m[1]}`, body)
        }
      }
    }
    put('ready.json', JSON.stringify({ version: EMULATOR_VERSION, cores, installedAt: new Date().toISOString() }))
    rmSync(final, { recursive: true, force: true })
    mkdirSync(dirname(final), { recursive: true })
    renameSync(temp, final)
    status = { state: 'ready', version: EMULATOR_VERSION, progress: 1, message: null }
  } catch (e) {
    rmSync(temp, { recursive: true, force: true })
    status = { state: 'failed', version: EMULATOR_VERSION, progress: 0, message: e instanceof Error ? e.message : String(e) }
    throw e
  }
}

export function installedCores(): string[] {
  try {
    return (JSON.parse(readFileSync(join(emulatorDir(), 'ready.json'), 'utf8')) as { cores: string[] }).cores
  } catch {
    return []
  }
}
