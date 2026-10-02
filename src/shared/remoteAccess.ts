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
export const API_VERSION = 1

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

export interface TailscaleGuestDevice {
  id: string
  hostname: string
  lastSeen: string | null
}
