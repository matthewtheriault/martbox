import { describe, expect, it } from 'vitest'
import { SAMPLE_RATE, creditsFrom, fingerprint, introFrom, markersFromChapters } from './markersCore'

// A seeded generator, so each "episode" gets its own audio but the tests
// always see the same.
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

// Music-like audio: a few tones that change every quarter second.
function music(seconds: number, seed: number): Float32Array {
  const rand = rng(seed)
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  const step = Math.round(SAMPLE_RATE / 4)
  let freqs = [0, 0, 0]
  for (let i = 0; i < out.length; i++) {
    if (i % step === 0) freqs = freqs.map(() => 200 + rand() * 1800)
    let v = 0
    for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE)
    out[i] = v / 3
  }
  return out
}

function episode(parts: Float32Array[], gain: number, noiseSeed: number): Int16Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Int16Array(total)
  const rand = rng(noiseSeed)
  let o = 0
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      out[o++] = Math.max(-32767, Math.min(32767, (p[i] * gain + (rand() - 0.5) * 0.05) * 12000))
    }
  }
  return out
}

describe('intro detection', () => {
  const theme = music(55, 1)

  it('finds the theme two episodes share, where it plays in each', () => {
    const a = fingerprint(episode([music(30, 2), theme, music(120, 3)], 1, 10))
    const b = fingerprint(episode([music(95, 4), theme, music(60, 5)], 0.6, 11))
    const intro = introFrom(a, b)
    expect(intro).not.toBeNull()
    expect(intro!.start).toBeGreaterThan(29)
    expect(intro!.start).toBeLessThan(31.5)
    expect(intro!.end).toBeGreaterThan(83.5)
    expect(intro!.end).toBeLessThan(86)
  })

  it('finds nothing in episodes that share no audio', () => {
    const a = fingerprint(episode([music(200, 6)], 1, 12))
    const b = fingerprint(episode([music(200, 7)], 1, 13))
    expect(introFrom(a, b)).toBeNull()
  })

  it('does not take shared silence or a steady tone for an intro', () => {
    const silence = new Float32Array(SAMPLE_RATE * 30)
    const tone = new Float32Array(SAMPLE_RATE * 30).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE))
    const a = fingerprint(episode([silence, tone, music(120, 30)], 1, 40))
    const b = fingerprint(episode([silence, tone, music(120, 31)], 1, 41))
    expect(introFrom(a, b)).toBeNull()
  })

  it('ignores a shared stretch too long to be an intro', () => {
    const shared = music(200, 8)
    const a = fingerprint(episode([music(20, 9), shared], 1, 14))
    const b = fingerprint(episode([music(40, 10), shared], 1, 15))
    expect(introFrom(a, b)).toBeNull()
  })
})

describe('credits detection', () => {
  it('finds where the shared credits start, in the episode', () => {
    const credits = music(45, 20)
    const a = fingerprint(episode([music(200, 21), credits], 1, 16))
    const b = fingerprint(episode([music(120, 22), credits, music(5, 23)], 0.8, 17))
    const start = creditsFrom(a, b, 1500)
    expect(start).not.toBeNull()
    expect(start!).toBeGreaterThan(1699)
    expect(start!).toBeLessThan(1701.5)
  })
})

describe('chapters', () => {
  it('reads intro and credits chapters', () => {
    expect(
      markersFromChapters([
        { start: 0, end: 62, title: 'Prologue' },
        { start: 62, end: 152.4, title: 'Opening' },
        { start: 152.4, end: 1300, title: 'Part A' },
        { start: 1300, end: 1390, title: 'Ending' }
      ])
    ).toEqual({ introStart: 62, introEnd: 152.4, creditsStart: 1300 })
  })

  it('leaves numbered chapters alone', () => {
    expect(
      markersFromChapters([
        { start: 0, end: 300, title: 'Chapter 1' },
        { start: 300, end: 600, title: 'Chapter 2' }
      ])
    ).toEqual({ introStart: null, introEnd: null, creditsStart: null })
  })
})
