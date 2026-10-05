import { basename, dirname, extname, sep } from 'path'
import type { GameSystem } from '../shared/types'

// Retro games (Phase 7): which system a file belongs to, a clean title from
// its name, and the files a disc game is made of. Pure, so it's tested
// without files (gamesCore.test.ts).

export interface SystemInfo {
  id: GameSystem
  name: string
  // The EmulatorJS core that plays it (downloaded by the server, see games.ts).
  core: string
  // Extensions only this system uses.
  extensions: string[]
  // Folder names that put an archive or a disc image (.zip, .bin…) in this system.
  folders: string[]
  // The system's folder in the libretro thumbnails collection (box art).
  thumbnails: string
}

export const SYSTEMS: SystemInfo[] = [
  { id: 'gba', name: 'Game Boy Advance', core: 'mgba', extensions: ['gba'], folders: ['gba', 'game boy advance', 'gameboy advance'], thumbnails: 'Nintendo - Game Boy Advance' },
  { id: 'gbc', name: 'Game Boy Color', core: 'mgba', extensions: ['gbc'], folders: ['gbc', 'game boy color', 'gameboy color'], thumbnails: 'Nintendo - Game Boy Color' },
  { id: 'gb', name: 'Game Boy', core: 'mgba', extensions: ['gb'], folders: ['gb', 'game boy', 'gameboy'], thumbnails: 'Nintendo - Game Boy' },
  { id: 'nes', name: 'NES', core: 'fceumm', extensions: ['nes', 'fds', 'unf', 'unif'], folders: ['nes', 'famicom', 'nintendo entertainment system'], thumbnails: 'Nintendo - Nintendo Entertainment System' },
  { id: 'snes', name: 'Super Nintendo', core: 'snes9x', extensions: ['sfc', 'smc'], folders: ['snes', 'super nintendo', 'super nes', 'super famicom', 'super nintendo entertainment system'], thumbnails: 'Nintendo - Super Nintendo Entertainment System' },
  { id: 'n64', name: 'Nintendo 64', core: 'mupen64plus_next', extensions: ['n64', 'z64', 'v64'], folders: ['n64', 'nintendo 64'], thumbnails: 'Nintendo - Nintendo 64' },
  { id: 'nds', name: 'Nintendo DS', core: 'melonds', extensions: ['nds'], folders: ['nds', 'ds', 'nintendo ds'], thumbnails: 'Nintendo - Nintendo DS' },
  { id: 'psx', name: 'PlayStation', core: 'pcsx_rearmed', extensions: ['cue', 'pbp', 'm3u'], folders: ['psx', 'ps1', 'psone', 'playstation', 'playstation 1', 'sony playstation'], thumbnails: 'Sony - PlayStation' }
]

export function systemInfo(id: string): SystemInfo | undefined {
  return SYSTEMS.find((s) => s.id === id)
}

// Files that only make sense with a system folder around them.
const SHARED_EXTENSIONS = ['zip', '7z', 'bin', 'img', 'iso']

const ext = (file: string): string => extname(file).slice(1).toLowerCase()

// The system a file is for, or null when it isn't a game we can play.
// `root` is the library folder: only folders below it name the system.
export function systemOf(file: string, root: string): GameSystem | null {
  const e = ext(file)
  const byExtension = SYSTEMS.find((s) => s.extensions.includes(e))
  if (byExtension) return byExtension.id
  if (!SHARED_EXTENSIONS.includes(e)) return null
  const folders = dirname(file).slice(root.length).split(/[\\/]/).map((f) => f.trim().toLowerCase()).filter(Boolean)
  // The nearest folder wins: "PlayStation/Extras/Game Boy" is Game Boy.
  for (const folder of folders.reverse()) {
    const system = SYSTEMS.find((s) => s.folders.includes(folder))
    if (system) {
      // Cartridge systems come as single files or archives, never as disc images.
      if (system.id !== 'psx' && !['zip', '7z'].includes(e)) return null
      if (system.id === 'psx' && e === '7z') return null
      return system.id
    }
  }
  return null
}

const REGIONS = ['USA', 'Europe', 'Japan', 'World', 'Australia', 'Canada', 'France', 'Germany', 'Italy', 'Spain', 'Korea', 'Brazil', 'Asia', 'UK']

export interface GameName {
  title: string
  region: string | null
  disc: number | null
}

// "Example Quest, The (USA) (Rev 1) [!].gba" → "The Example Quest", USA.
export function gameName(file: string): GameName {
  let name = basename(file, extname(file))
  let region: string | null = null
  let disc: number | null = null
  for (const m of name.matchAll(/\(([^)]*)\)/g)) {
    const inside = m[1]
    const found = inside.split(/,\s*/).find((part) => REGIONS.includes(part))
    if (found && !region) region = found
    const d = /^Disc\s*(\d+)/i.exec(inside)
    if (d) disc = parseInt(d[1], 10)
  }
  name = name.replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  // "Title, The" and "Title, A" put the article back in front.
  const article = /^(.*), (The|A|An)( - .*)?$/i.exec(name)
  if (article) name = `${article[2]} ${article[1]}${article[3] ?? ''}`
  return { title: name || basename(file), region, disc }
}

// The track files a .cue sheet names, relative to the sheet's folder.
export function cueFiles(cue: string): string[] {
  const files: string[] = []
  for (const line of cue.split(/\r?\n/)) {
    const m = /^\s*FILE\s+(?:"([^"]+)"|(\S+))/i.exec(line)
    if (m) files.push((m[1] ?? m[2]).split(/[\\/]/).join(sep))
  }
  return files
}

// The discs an .m3u playlist lists.
export function m3uFiles(m3u: string): string[] {
  return m3u
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/[\\/]/).join(sep))
}

// libretro thumbnails name box art after the game's file name, with the
// characters file systems dislike replaced by "_".
export function thumbnailName(file: string): string {
  return basename(file, extname(file)).replace(/[&*/:`<>?\\|"]/g, '_')
}
