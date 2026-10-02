import { createHash, randomBytes } from 'crypto'

// Pure helpers behind server-local users (Jellyfin/Emby model): the admin
// creates a user, MartBox mints a one-time login code, and redeeming it
// gives that device its own long-lived key. No Electron or DB imports here
// so it can be unit-tested directly; auth.ts holds the storage side.

// Crockford base32 without the look-alikes (I, L, O, U) — friendly to type
// on a TV remote and unambiguous when read aloud.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_GROUPS = 3
const CODE_GROUP_LENGTH = 4
export const LOGIN_CODE_PREFIX = 'MART'
// 12 characters × 5 bits = 60 bits of randomness, which together with the
// one-time use, the expiry and the redeem rate limit makes guessing a live
// code impractical.
export const LOGIN_CODE_TTL_MS = 48 * 60 * 60 * 1000

export function generateLoginCode(): string {
  const length = CODE_GROUPS * CODE_GROUP_LENGTH
  const bytes = randomBytes(length)
  let chars = ''
  // 256 is a multiple of 32, so a plain modulo has no bias.
  for (let i = 0; i < length; i++) chars += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  const groups: string[] = []
  for (let i = 0; i < length; i += CODE_GROUP_LENGTH) groups.push(chars.slice(i, i + CODE_GROUP_LENGTH))
  return [LOGIN_CODE_PREFIX, ...groups].join('-')
}

// Accepts what people actually type: any case, spaces or no dashes, the
// prefix or not, and O/I/L typed for 0/1/1. Returns the canonical form, or
// null if it can't be a login code.
export function normalizeLoginCode(input: string): string | null {
  const length = CODE_GROUPS * CODE_GROUP_LENGTH
  let s = input.toUpperCase().replace(/[\s-]/g, '')
  // Only strip the prefix when it's actually extra — a code typed without
  // it can legitimately start with the letters M, A, R, T.
  if (s.length === LOGIN_CODE_PREFIX.length + length && s.startsWith(LOGIN_CODE_PREFIX)) {
    s = s.slice(LOGIN_CODE_PREFIX.length)
  }
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1')
  if (s.length !== length) return null
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null
  const groups: string[] = []
  for (let i = 0; i < length; i += CODE_GROUP_LENGTH) groups.push(s.slice(i, i + CODE_GROUP_LENGTH))
  return [LOGIN_CODE_PREFIX, ...groups].join('-')
}

export function looksLikeLoginCode(input: string): boolean {
  return normalizeLoginCode(input) !== null
}

// 256-bit random key, sent as a bearer token on every request.
export function generateDeviceKey(): string {
  return randomBytes(32).toString('base64url')
}

// Codes and keys are high-entropy random values, so a plain SHA-256 is the
// right hash: there's nothing to brute-force that a slow KDF would protect.
// Lookups go by hash, so the stored value never needs comparing to a secret.
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

// Tailscale assigns IPv4 addresses from the shared 100.64/10 range (RFC 6598)
// and IPv6 from fd7a:115c:a1e0::/48.
export function isTailnetAddress(addr: string): boolean {
  const v4 = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr)
  if (v4) {
    const [a, b, c] = v4.slice(1).map(Number)
    return a >= 64 && a <= 127 && b <= 255 && c <= 255
  }
  return /^fd7a:115c:a1e0:/i.test(addr)
}

export function isExpired(expiresAt: string, now = Date.now()): boolean {
  return Date.parse(expiresAt) <= now
}

// Routes a remote device may call with no device key: the version check
// (clients run it before anything else), "am I signed in / is a login
// required" (so an app knows to ask for a code; it reveals no data to a
// caller without a key), and redeeming a login code (how a device gets a key
// in the first place). Everything else needs a key — an allow-list, so a
// newly added route is protected by default.
const PUBLIC_REMOTE_ROUTES = new Set(['/api/version', '/api/auth/me', '/api/auth/redeem'])

export function isPublicRemoteRoute(path: string): boolean {
  return PUBLIC_REMOTE_ROUTES.has(path)
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match ? match[1] : null
}

// Every remote request reaches the server through the Tailscale sidecar, so
// they all share one loopback address — this limits failed redeem attempts
// globally rather than per caller. A real friend mistyping a code a few
// times never trips it; a guessing loop does, and then waits out the lock.
export class FailureLimiter {
  private failures: number[] = []
  private lockedUntil = 0

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 10 * 60 * 1000,
    private readonly lockMs = 15 * 60 * 1000
  ) {}

  isLocked(now = Date.now()): boolean {
    return now < this.lockedUntil
  }

  retryAfterMs(now = Date.now()): number {
    return Math.max(0, this.lockedUntil - now)
  }

  recordFailure(now = Date.now()): void {
    this.failures = this.failures.filter((t) => now - t < this.windowMs)
    this.failures.push(now)
    if (this.failures.length >= this.maxFailures) {
      this.lockedUntil = now + this.lockMs
      this.failures = []
    }
  }

  recordSuccess(): void {
    this.failures = []
  }
}
