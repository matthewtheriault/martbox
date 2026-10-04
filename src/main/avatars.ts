import { app, nativeImage } from 'electron'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { setProfileAvatarPhoto } from './repository'

// Profile photos: cropped to a square, 320 px, stored as JPEG in the
// user-data folder (kept across updates, like everything else there).

const SIZE = 320
// The decoded upload is at most this many bytes.
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

function dir(): string {
  const d = join(app.getPath('userData'), 'avatars')
  mkdirSync(d, { recursive: true })
  return d
}

export function avatarPath(profileId: number): string | null {
  const p = join(dir(), `${profileId}.jpg`)
  return existsSync(p) ? p : null
}

// Returns false when the bytes aren't an image Electron can read.
export function saveAvatar(profileId: number, image: Buffer): boolean {
  if (image.length === 0 || image.length > MAX_UPLOAD_BYTES) return false
  const img = nativeImage.createFromBuffer(image)
  if (img.isEmpty()) return false
  const { width, height } = img.getSize()
  const side = Math.min(width, height)
  const square = img.crop({
    x: Math.floor((width - side) / 2),
    y: Math.floor((height - side) / 2),
    width: side,
    height: side
  })
  const jpeg = square.resize({ width: SIZE, height: SIZE, quality: 'best' }).toJPEG(85)
  writeFileSync(join(dir(), `${profileId}.jpg`), jpeg)
  setProfileAvatarPhoto(profileId, Date.now())
  return true
}

export function removeAvatar(profileId: number): void {
  rmSync(join(dir(), `${profileId}.jpg`), { force: true })
  setProfileAvatarPhoto(profileId, null)
}
