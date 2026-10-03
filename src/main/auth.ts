import { randomBytes } from 'crypto'
import { db, getSetting, setSetting } from './db'
import { listProfiles } from './repository'
import {
  FailureLimiter,
  LOGIN_CODE_TTL_MS,
  generateDeviceKey,
  generateLoginCode,
  hashSecret,
  isExpired,
  isTailnetAddress,
  MEDIA_TOKEN_TTL_MS,
  signMediaToken,
  verifyMediaToken,
  normalizeLoginCode
} from './authCore'
import type { Profile, UserDevice } from '../shared/types'

// Storage side of server-local users — see authCore.ts for the rules.

const redeemLimiter = new FailureLimiter()

// last_seen_at is for the admin's device list, not an audit log — writing
// it on every request (dozens per screen) would be wasted disk churn.
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000
const lastSeenWrittenAt = new Map<number, number>()

function rowToDevice(r: any): UserDevice {
  return {
    id: r.id,
    profileId: r.profile_id,
    name: r.name,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    speedMbps: r.speed_mbps ?? null,
    latencyMs: r.latency_ms ?? null,
    speedTestedAt: r.speed_tested_at ?? null
  }
}

function findProfile(id: number): Profile | undefined {
  return listProfiles().find((p) => p.id === id)
}

export function createLoginCode(profileId: number): {
  loginCode: string
  expiresAt: string
} {
  const profile = findProfile(profileId)
  if (!profile) throw new Error('Unknown user')
  if (profile.disabled) throw new Error('This user is disabled — enable them first.')
  const loginCode = generateLoginCode()
  const expiresAt = new Date(Date.now() + LOGIN_CODE_TTL_MS).toISOString()
  db.prepare('INSERT INTO login_codes (profile_id, code_hash, expires_at) VALUES (?, ?, ?)').run(
    profileId,
    hashSecret(loginCode),
    expiresAt
  )
  return { loginCode, expiresAt }
}

export type RedeemResult =
  | { ok: true; deviceKey: string; profile: Profile }
  | {
      ok: false
      reason: 'invalid' | 'expired' | 'used' | 'disabled' | 'locked'
      retryAfterMs?: number
    }

export function redeemLoginCode(
  input: string,
  deviceName: string,
  tailscaleAddr: string | null
): RedeemResult {
  if (redeemLimiter.isLocked()) {
    return {
      ok: false,
      reason: 'locked',
      retryAfterMs: redeemLimiter.retryAfterMs()
    }
  }
  const code = normalizeLoginCode(input)
  const row = code
    ? (db.prepare('SELECT * FROM login_codes WHERE code_hash = ?').get(hashSecret(code)) as any)
    : undefined
  if (!row) {
    redeemLimiter.recordFailure()
    return { ok: false, reason: 'invalid' }
  }
  if (row.used_at) return { ok: false, reason: 'used' }
  if (isExpired(row.expires_at)) return { ok: false, reason: 'expired' }
  const profile = findProfile(row.profile_id)
  if (!profile) return { ok: false, reason: 'invalid' }
  if (profile.disabled) return { ok: false, reason: 'disabled' }

  const deviceKey = generateDeviceKey()
  const name = deviceName.trim().slice(0, 80) || 'Unnamed device'
  // The address is self-reported (the sidecar forwards raw TCP, so the host
  // can't see the real peer). Only keep a plausible tailnet address that no
  // other device has claimed — otherwise signing this device out could
  // remove a different friend's device from the tailnet.
  const addr =
    tailscaleAddr &&
    isTailnetAddress(tailscaleAddr) &&
    !db.prepare('SELECT 1 FROM devices WHERE tailscale_addr = ?').get(tailscaleAddr)
      ? tailscaleAddr
      : null
  // Conditional update so two simultaneous redeems of one code can't both
  // succeed.
  const claimed = db.transaction((): boolean => {
    const result = db
      .prepare("UPDATE login_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL")
      .run(row.id)
    if (result.changes !== 1) return false
    db.prepare(
      "INSERT INTO devices (profile_id, name, key_hash, tailscale_addr, last_seen_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(profile.id, name, hashSecret(deviceKey), addr)
    return true
  })()
  if (!claimed) return { ok: false, reason: 'used' }
  redeemLimiter.recordSuccess()
  return { ok: true, deviceKey, profile }
}

export interface AuthenticatedDevice {
  device: UserDevice
  profile: Profile
}

// null = unknown, revoked, or belongs to a disabled/deleted user.
export function authenticateDeviceKey(deviceKey: string): AuthenticatedDevice | null {
  const row = db.prepare('SELECT * FROM devices WHERE key_hash = ?').get(hashSecret(deviceKey)) as
    any | undefined
  if (!row) return null
  const profile = findProfile(row.profile_id)
  if (!profile || profile.disabled) return null

  const now = Date.now()
  if (now - (lastSeenWrittenAt.get(row.id) ?? 0) > LAST_SEEN_WRITE_INTERVAL_MS) {
    lastSeenWrittenAt.set(row.id, now)
    db.prepare("UPDATE devices SET last_seen_at = datetime('now') WHERE id = ?").run(row.id)
  }
  return { device: rowToDevice(row), profile }
}

export function saveDeviceSpeed(deviceId: number, mbps: number, latencyMs: number): void {
  db.prepare(
    "UPDATE devices SET speed_mbps = ?, latency_ms = ?, speed_tested_at = datetime('now') WHERE id = ?"
  ).run(mbps, latencyMs, deviceId)
}

// HMAC key for signed media links, created once per server. Not a user
// secret — losing it just invalidates outstanding links, which clients
// refetch.
function mediaTokenSecret(): string {
  let secret = getSetting('mediaTokenSecret')
  if (!secret) {
    secret = randomBytes(32).toString('hex')
    setSetting('mediaTokenSecret', secret)
  }
  return secret
}

export function createMediaToken(deviceId: number): { token: string; expiresAt: string } {
  const expiresAtMs = Date.now() + MEDIA_TOKEN_TTL_MS
  return {
    token: signMediaToken(mediaTokenSecret(), deviceId, expiresAtMs),
    expiresAt: new Date(expiresAtMs).toISOString()
  }
}

// Same rules as a device key: the device must still exist and its user
// must not be disabled.
export function authenticateMediaToken(token: string): AuthenticatedDevice | null {
  const deviceId = verifyMediaToken(mediaTokenSecret(), token)
  if (deviceId === null) return null
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as any | undefined
  if (!row) return null
  const profile = findProfile(row.profile_id)
  if (!profile || profile.disabled) return null
  return { device: rowToDevice(row), profile }
}

export function listDevices(profileId?: number): UserDevice[] {
  const rows =
    profileId === undefined
      ? db.prepare('SELECT * FROM devices ORDER BY created_at DESC').all()
      : db
          .prepare('SELECT * FROM devices WHERE profile_id = ? ORDER BY created_at DESC')
          .all(profileId)
  return (rows as any[]).map(rowToDevice)
}

// Returns the device's tailnet address (if it reported one) so the caller
// can also remove it from the tailnet.
export function revokeDevice(deviceId: number): string | null {
  const row = db.prepare('SELECT tailscale_addr FROM devices WHERE id = ?').get(deviceId) as
    { tailscale_addr: string | null } | undefined
  db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId)
  lastSeenWrittenAt.delete(deviceId)
  return row?.tailscale_addr ?? null
}

// Disabling signs the user out everywhere and voids their unused codes;
// returns the tailnet addresses of the devices that were removed.
export function setUserDisabled(profileId: number, disabled: boolean): string[] {
  const profile = findProfile(profileId)
  if (!profile) throw new Error('Unknown user')
  if (profile.isAdmin && disabled) throw new Error("The admin can't be disabled.")
  let addrs: string[] = []
  db.transaction(() => {
    db.prepare('UPDATE profiles SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, profileId)
    if (disabled) {
      addrs = (
        db
          .prepare(
            'SELECT tailscale_addr FROM devices WHERE profile_id = ? AND tailscale_addr IS NOT NULL'
          )
          .all(profileId) as { tailscale_addr: string }[]
      ).map((r) => r.tailscale_addr)
      db.prepare('DELETE FROM devices WHERE profile_id = ?').run(profileId)
      db.prepare('DELETE FROM login_codes WHERE profile_id = ? AND used_at IS NULL').run(profileId)
    }
  })()
  return addrs
}

// Tailnet addresses of every device a user had — for removing them from
// the tailnet before the profile (and, by cascade, its devices) is deleted.
// Matches a device to its Tailscale peer status for the dashboard; never
// shown.
export function deviceTailnetAddr(deviceId: number): string | null {
  const row = db.prepare('SELECT tailscale_addr FROM devices WHERE id = ?').get(deviceId) as
    | { tailscale_addr: string | null }
    | undefined
  return row?.tailscale_addr ?? null
}

export function deviceAddrsForProfile(profileId: number): string[] {
  return (
    db
      .prepare(
        'SELECT tailscale_addr FROM devices WHERE profile_id = ? AND tailscale_addr IS NOT NULL'
      )
      .all(profileId) as { tailscale_addr: string }[]
  ).map((r) => r.tailscale_addr)
}
