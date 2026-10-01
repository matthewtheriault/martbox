export const TSNET_FIXED_PORT = 47823

export type RemoteAccessMode = 'off' | 'host' | 'client'

export interface RemoteAccessStatus {
  status: 'idle' | 'starting' | 'connected' | 'error'
  tailscaleAddr?: string
  localPort?: number
  message?: string
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
