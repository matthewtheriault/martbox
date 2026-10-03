import type { Profile } from './types'

export const TSNET_FIXED_PORT = 47823

// Fixed UDP port the host's sidecar uses for WireGuard/peer-to-peer traffic,
// so it can be forwarded on the router to let friends connect directly
// instead of through Tailscale's relays. Deliberately not 41641 (the regular
// Tailscale client's default) so the two can coexist on one machine.
export const TSNET_UDP_PORT = 41642

// Bumped whenever the host's HTTP API changes in a way an older client (or
// an older host) can't handle. Clients compare it against the host's
// /api/version so a mismatch shows "update the server" / "update this app"
// instead of half-working screens. App versions can differ freely as long as
// this matches.
// 2: server-local users — device keys, /api/auth/*, login-checked remote
// listener.
export const API_VERSION = 2

export interface ServerVersionInfo {
  appVersion: string
  apiVersion: number
}

export interface ServerCompatibility {
  // null = the host is too old to report a version (pre-0.2).
  server: ServerVersionInfo | null
  clientApiVersion: number
  compatible: boolean
  // Which side needs updating when they don't match.
  needsUpdate: 'server' | 'app' | null
}

export type RemoteAccessMode = 'off' | 'host' | 'client'

// How traffic to a tailnet peer is currently flowing. 'relayed' means it's
// going through Tailscale's shared DERP relays, which are much slower than a
// direct connection; 'idle' means no recent traffic, so there's no path yet.
export interface PeerConnection {
  hostname: string
  online: boolean
  path: 'direct' | 'relayed' | 'idle'
  relayRegion?: string
  // Tailnet address, for matching peers to signed-in devices; never shown.
  addr?: string
}

export interface RemoteAccessStatus {
  status: 'idle' | 'starting' | 'connected' | 'error'
  tailscaleAddr?: string
  localPort?: number
  message?: string
  // Host mode: every peer in the tailnet. Client mode: just the host.
  peers?: PeerConnection[]
}

export interface InviteCode {
  v: 1
  authKey: string
  hostAddr: string
  port: number
}

// v2 adds a one-time login code: the device joins the tailnet with the
// Tailscale key, then redeems the code for its own device key, signing in
// as the user the admin made the code for.
export interface InviteCodeV2 {
  v: 2
  name: string
  loginCode: string
  tailscale: { authKey: string; hostAddr: string; port: number }
}

// What /api/auth/me reports about the calling device.
export interface RemoteSession {
  kind: 'local' | 'device' | 'legacy' | 'anonymous'
  profile: Profile | null
  loginRequired: boolean
}

export interface TailscaleGuestDevice {
  id: string
  hostname: string
  lastSeen: string | null
  addresses: string[]
}

// Result of checking the tailnet policy file (tailnetPolicy.ts).
export interface TailnetPolicyCheck {
  // An allow-everything rule is present.
  allowAll: boolean
  // Friends' devices may reach the MartBox port on the host.
  guestGrant: boolean
  // Both MartBox tags have owners (needed to create invites).
  tagOwners: boolean
  // Other rules that let friends' devices reach something — reported, not
  // removed automatically.
  extraGuestRules: number
  lockedDown: boolean
}
