import { encryptedGetSetting } from './db'
import type { TailscaleGuestDevice } from '../shared/remoteAccess'

const API_BASE = 'https://api.tailscale.com/api/v2'

function authHeader(token: string): string {
  return `Basic ${Buffer.from(`${token}:`).toString('base64')}`
}

function requireToken(): string {
  const token = encryptedGetSetting('tailscaleApiToken')
  if (!token) throw new Error('No Tailscale API token saved')
  return token
}

export async function testApiToken(token: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/tailnet/-/devices`, {
    headers: { Authorization: authHeader(token) }
  })
  return res.ok
}

interface MintKeyOptions {
  tag: string
  reusable: boolean
  expirySeconds: number
  description: string
}

async function mintAuthKey(opts: MintKeyOptions): Promise<string> {
  const token = requireToken()

  const res = await fetch(`${API_BASE}/tailnet/-/keys`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(token),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      capabilities: {
        devices: {
          create: {
            reusable: opts.reusable,
            ephemeral: false,
            preauthorized: true,
            tags: [opts.tag]
          }
        }
      },
      expirySeconds: opts.expirySeconds,
      description: opts.description
    })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Tailscale API error (${res.status}): ${text || res.statusText}`)
  }

  const data = (await res.json()) as { key: string }
  return data.key
}

// Reusable so the host can re-provision the sidecar without going back to
// Settings; ephemeral:false since the host device should stay in the tailnet
// across restarts.
export function mintHostKey(): Promise<string> {
  return mintAuthKey({
    tag: 'tag:martbox-host',
    reusable: true,
    expirySeconds: 90 * 24 * 60 * 60,
    description: 'MartBox host node'
  })
}

// Single-use and short-lived — only good for redeeming one invite. The
// guest device itself is not ephemeral once joined, so a friend doesn't
// need a fresh invite every session.
export function mintGuestKey(): Promise<string> {
  return mintAuthKey({
    tag: 'tag:martbox-guest',
    reusable: false,
    expirySeconds: 60 * 60,
    description: 'MartBox guest invite'
  })
}

// A guest device stays in the tailnet indefinitely once joined — the invite
// key itself is single-use, but nothing else expires it. This is the only
// way to actually revoke someone short of going to the Tailscale admin
// console directly.
export async function listGuestDevices(): Promise<TailscaleGuestDevice[]> {
  const token = requireToken()
  const res = await fetch(`${API_BASE}/tailnet/-/devices`, {
    headers: { Authorization: authHeader(token) }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Tailscale API error (${res.status}): ${text || res.statusText}`)
  }
  const data = (await res.json()) as {
    devices: Array<{
      id: string
      hostname: string
      tags?: string[]
      lastSeen?: string
      addresses?: string[]
    }>
  }
  return (data.devices ?? [])
    .filter((d) => (d.tags ?? []).includes('tag:martbox-guest'))
    .map((d) => ({
      id: d.id,
      hostname: d.hostname,
      lastSeen: d.lastSeen ?? null,
      addresses: d.addresses ?? []
    }))
}

// Signing a MartBox user's device out also removes it from the tailnet when
// the device reported its tailnet address at sign-in. Best-effort: with no
// API token saved (or the device already gone) there's nothing to remove.
export async function revokeGuestDevicesByAddr(addrs: string[]): Promise<void> {
  if (addrs.length === 0 || encryptedGetSetting('tailscaleApiToken') === null) return
  const wanted = new Set(addrs)
  const guests = await listGuestDevices()
  for (const guest of guests) {
    if (guest.addresses.some((a) => wanted.has(a))) await revokeGuestDevice(guest.id)
  }
}

export async function revokeGuestDevice(deviceId: string): Promise<void> {
  const token = requireToken()
  const res = await fetch(`${API_BASE}/device/${deviceId}`, {
    method: 'DELETE',
    headers: { Authorization: authHeader(token) }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Tailscale API error (${res.status}): ${text || res.statusText}`)
  }
}
