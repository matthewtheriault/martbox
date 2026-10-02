import { describe, expect, it } from 'vitest'
import {
  FailureLimiter,
  bearerToken,
  generateDeviceKey,
  generateLoginCode,
  hashSecret,
  isExpired,
  isPublicRemoteRoute,
  isTailnetAddress,
  isMediaRoute,
  signMediaToken,
  verifyMediaToken,
  normalizeLoginCode
} from './authCore'

describe('login codes', () => {
  it('generates MART-XXXX-XXXX-XXXX codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateLoginCode()
      expect(code).toMatch(/^MART-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    }
  })

  it('generates different codes each time', () => {
    const codes = new Set(Array.from({ length: 500 }, generateLoginCode))
    expect(codes.size).toBe(500)
  })

  it('normalizes what people type', () => {
    expect(normalizeLoginCode('mart-abcd-efgh-jk12')).toBe('MART-ABCD-EFGH-JK12')
    expect(normalizeLoginCode('ABCD EFGH JK12')).toBe('MART-ABCD-EFGH-JK12')
    expect(normalizeLoginCode('abcdefghjk12')).toBe('MART-ABCD-EFGH-JK12')
    // O → 0, I and L → 1
    expect(normalizeLoginCode('MART-OOOO-IIII-LLLL')).toBe('MART-0000-1111-1111')
    // A code whose first group is MART, typed without the prefix
    expect(normalizeLoginCode('martabcdefgh')).toBe('MART-MART-ABCD-EFGH')
  })

  it('rejects input that cannot be a code', () => {
    expect(normalizeLoginCode('')).toBeNull()
    expect(normalizeLoginCode('MART-ABCD-EFG')).toBeNull()
    expect(normalizeLoginCode('MART-ABCD-EFGH-JK12-3')).toBeNull()
    expect(normalizeLoginCode('MART-ABCD-EFGH-JKU2')).toBeNull()
    expect(normalizeLoginCode('eyJ2IjoyfQ==')).toBeNull()
  })

  it('round-trips generated codes through normalization', () => {
    const code = generateLoginCode()
    expect(normalizeLoginCode(code.toLowerCase())).toBe(code)
  })
})

describe('secrets', () => {
  it('makes 256-bit url-safe device keys', () => {
    const key = generateDeviceKey()
    expect(Buffer.from(key, 'base64url')).toHaveLength(32)
    expect(key).not.toMatch(/[+/=]/)
  })

  it('hashes deterministically without exposing the secret', () => {
    const key = generateDeviceKey()
    expect(hashSecret(key)).toBe(hashSecret(key))
    expect(hashSecret(key)).not.toContain(key)
    expect(hashSecret(key)).toHaveLength(64)
  })

  it('checks expiry', () => {
    const now = Date.parse('2026-10-02T12:00:00Z')
    expect(isExpired('2026-10-02T11:59:59Z', now)).toBe(true)
    expect(isExpired('2026-10-02T12:00:00Z', now)).toBe(true)
    expect(isExpired('2026-10-02T12:00:01Z', now)).toBe(false)
  })
})

describe('remote route rules', () => {
  it('only exempts the version check, the session check and code redemption', () => {
    expect(isPublicRemoteRoute('/api/version')).toBe(true)
    expect(isPublicRemoteRoute('/api/auth/me')).toBe(true)
    expect(isPublicRemoteRoute('/api/auth/redeem')).toBe(true)
    for (const path of [
      '/api/profiles',
      '/api/movies',
      '/api/auth/me/',
      '/stream/movie/1',
      '/image',
      '/api/version/',
      '/api/auth/redeem/x'
    ]) {
      expect(isPublicRemoteRoute(path)).toBe(false)
    }
  })

  it('parses bearer tokens', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('bearer  abc ')).toBe('abc')
    expect(bearerToken('Basic abc')).toBeNull()
    expect(bearerToken('Bearer')).toBeNull()
    expect(bearerToken(undefined)).toBeNull()
  })
})

describe('FailureLimiter', () => {
  it('locks after too many failures and unlocks later', () => {
    const limiter = new FailureLimiter(3, 60_000, 300_000)
    const t0 = 1_000_000
    limiter.recordFailure(t0)
    limiter.recordFailure(t0 + 1)
    expect(limiter.isLocked(t0 + 2)).toBe(false)
    limiter.recordFailure(t0 + 2)
    expect(limiter.isLocked(t0 + 3)).toBe(true)
    expect(limiter.retryAfterMs(t0 + 3)).toBe(299_999)
    expect(limiter.isLocked(t0 + 2 + 300_000)).toBe(false)
  })

  it('forgets failures outside the window', () => {
    const limiter = new FailureLimiter(3, 60_000, 300_000)
    limiter.recordFailure(0)
    limiter.recordFailure(1)
    limiter.recordFailure(61_000)
    expect(limiter.isLocked(61_001)).toBe(false)
  })

  it('resets on success', () => {
    const limiter = new FailureLimiter(3, 60_000, 300_000)
    limiter.recordFailure(0)
    limiter.recordFailure(1)
    limiter.recordSuccess()
    limiter.recordFailure(2)
    expect(limiter.isLocked(3)).toBe(false)
  })
})

describe('isTailnetAddress', () => {
  it('accepts Tailscale ranges only', () => {
    expect(isTailnetAddress(['100', '64', '0', '1'].join('.'))).toBe(true)
    expect(isTailnetAddress(['100', '127', '255', '254'].join('.'))).toBe(true)
    expect(isTailnetAddress('fd7a:115c:a1e0::1')).toBe(true)
    expect(isTailnetAddress(['100', '63', '0', '1'].join('.'))).toBe(false)
    expect(isTailnetAddress(['100', '128', '0', '1'].join('.'))).toBe(false)
    expect(isTailnetAddress(['192', '168', '1', '2'].join('.'))).toBe(false)
    expect(isTailnetAddress('not an ip')).toBe(false)
  })
})

describe('media tokens', () => {
  const secret = 'test-secret'
  const now = Date.parse('2026-10-02T12:00:00Z')

  it('round-trips a device id', () => {
    const token = signMediaToken(secret, 42, now + 60_000)
    expect(verifyMediaToken(secret, token, now)).toBe(42)
  })

  it('rejects expired tokens', () => {
    const token = signMediaToken(secret, 42, now - 1000)
    expect(verifyMediaToken(secret, token, now)).toBeNull()
  })

  it('rejects tampered tokens and the wrong secret', () => {
    const token = signMediaToken(secret, 42, now + 60_000)
    const [, sig] = token.split('.')
    const forged = `${Buffer.from(`1.${Math.floor((now + 60_000) / 1000)}`).toString('base64url')}.${sig}`
    expect(verifyMediaToken(secret, forged, now)).toBeNull()
    expect(verifyMediaToken('other-secret', token, now)).toBeNull()
    expect(verifyMediaToken(secret, 'garbage', now)).toBeNull()
    expect(verifyMediaToken(secret, `${token}.x`, now)).toBeNull()
  })

  it('only covers media routes', () => {
    for (const p of ['/stream/movie/1', '/probe/episode/2', '/subtitles/movie/1/0', '/image']) {
      expect(isMediaRoute(p)).toBe(true)
    }
    for (const p of ['/api/movies', '/api/profiles', '/api/auth/me', '/images', '/streams']) {
      expect(isMediaRoute(p)).toBe(false)
    }
  })
})
