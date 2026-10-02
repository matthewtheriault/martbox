import { hostname } from 'os'
import { deleteSetting, encryptedGetSetting, encryptedSetSetting } from './db'
import { getSidecarLocalPort } from './tsnetSidecar'
import type { Profile } from '../shared/types'

// Client mode: this device's sign-in with the host. The device key (from
// redeeming a login code) is kept encrypted with the OS keychain and sent
// on every request to the host — API calls via remoteClient.ts, and media
// (<video>, <img>) via the header injection in index.ts.

const DEVICE_KEY_SETTING = 'remoteDeviceKey'
const PENDING_CODE_SETTING = 'remotePendingLoginCode'

let ownTailscaleAddr: string | null = null

export function getDeviceKey(): string | null {
  return encryptedGetSetting(DEVICE_KEY_SETTING)
}

export function clearDeviceKey(): void {
  deleteSetting(DEVICE_KEY_SETTING)
}

export function authHeaders(): Record<string, string> {
  const key = getDeviceKey()
  return key ? { Authorization: `Bearer ${key}` } : {}
}

// A v2 invite's login code can only be redeemed once the tunnel is up —
// kept (encrypted) until then, so it survives a relaunch mid-connect.
export function setPendingLoginCode(code: string): void {
  encryptedSetSetting(PENDING_CODE_SETTING, code)
}

const REDEEM_ERRORS: Record<string, string> = {
  invalid: "That login code isn't valid. Check it and try again.",
  expired: 'That login code has expired. Ask the server owner for a new one.',
  used: 'That login code was already used. Ask the server owner for a new one.',
  disabled: 'This user has been disabled on the server.'
}

export async function redeemLoginCode(code: string): Promise<Profile> {
  const port = getSidecarLocalPort()
  if (!port) throw new Error('Not connected to the server yet — wait for it to connect, then try again.')
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      deviceName: `${hostname()} (MartBox desktop)`,
      tailscaleAddr: ownTailscaleAddr
    })
  })
  if (res.status === 404) {
    throw new Error('The server is running an older MartBox without logins. Ask the owner to update it.')
  }
  const body = (await res.json().catch(() => ({}))) as {
    deviceKey?: string
    profile?: Profile
    error?: string
    retryAfterMs?: number
  }
  if (!res.ok || !body.deviceKey || !body.profile) {
    if (body.error === 'locked') {
      const minutes = Math.ceil((body.retryAfterMs ?? 0) / 60000)
      throw new Error(`Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`)
    }
    throw new Error(REDEEM_ERRORS[body.error ?? ''] ?? `Sign-in failed (${res.status}).`)
  }
  encryptedSetSetting(DEVICE_KEY_SETTING, body.deviceKey)
  deleteSetting(PENDING_CODE_SETTING)
  return body.profile
}

// Called for every client-mode sidecar status. Remembers this device's own
// tailnet address (so the host can remove it from the tailnet if the admin
// signs it out) and redeems a pending login code once connected.
export async function handleClientStatus(status: {
  status: string
  tailscaleAddr?: string
}): Promise<string | null> {
  if (status.tailscaleAddr) ownTailscaleAddr = status.tailscaleAddr
  if (status.status !== 'connected') return null
  const pending = encryptedGetSetting(PENDING_CODE_SETTING)
  if (!pending) return null
  try {
    await redeemLoginCode(pending)
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // A code that can never work shouldn't be retried on every reconnect.
    if (!/wait for it to connect|Try again in/.test(message)) deleteSetting(PENDING_CODE_SETTING)
    return message
  }
}
