import { describe, expect, it } from 'vitest'
import { pickArtColor } from './artColorCore'

const image = (...areas: [count: number, rgb: [number, number, number]][]): Uint8Array =>
  Uint8Array.from(areas.flatMap(([n, rgb]) => Array.from({ length: n }, () => rgb).flat()))

const hue = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

describe('artwork colour', () => {
  it('finds the main colour, ignoring black and white', () => {
    // Mostly black with a large red area and a little blue.
    const c = pickArtColor(image([300, [0, 0, 0]], [200, [220, 30, 40]], [20, [30, 60, 230]], [56, [255, 255, 255]]))
    expect(c).not.toBeNull()
    // Red sits either side of 0°.
    expect(Math.min(hue(c!), 360 - hue(c!))).toBeLessThan(15)
  })

  it('is null for black-and-white artwork', () => {
    expect(pickArtColor(image([400, [0, 0, 0]], [176, [240, 240, 240]], [2, [200, 20, 20]]))).toBeNull()
  })

  it('gives a mid shade, never neon or near-black', () => {
    const c = pickArtColor(image([576, [255, 255, 0]]))!
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
    expect(Math.max(r, g, b)).toBeLessThan(240)
    expect(Math.max(r, g, b)).toBeGreaterThan(120)
  })
})
