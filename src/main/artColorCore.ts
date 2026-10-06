// The colour a piece of artwork is "about" (Phase 8): the strongest hue
// among its vivid pixels, then calmed to a shade that works as a glow
// behind white text on a black page. Pure, so it's tested without images.

function hsv(r: number, g: number, b: number): [h: number, s: number, v: number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = (h * 60 + 360) % 360
  }
  return [h, max === 0 ? 0 : d / max, max / 255]
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')
}

// `rgb`: pixels as R,G,B bytes (a small thumbnail). null when the artwork
// has no real colour (black and white, or nearly so).
export function pickArtColor(rgb: Uint8Array): string | null {
  const BUCKETS = 12
  const weight = new Array<number>(BUCKETS).fill(0)
  const hueX = new Array<number>(BUCKETS).fill(0)
  const hueY = new Array<number>(BUCKETS).fill(0)
  const sat = new Array<number>(BUCKETS).fill(0)
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const [h, s, v] = hsv(rgb[i], rgb[i + 1], rgb[i + 2])
    if (v < 0.2 || s < 0.25) continue
    const w = s * v
    const k = Math.floor(h / (360 / BUCKETS)) % BUCKETS
    weight[k] += w
    // Hue is circular: average it as a direction.
    hueX[k] += Math.cos((h * Math.PI) / 180) * w
    hueY[k] += Math.sin((h * Math.PI) / 180) * w
    sat[k] += s * w
  }
  let best = -1
  for (let k = 0; k < BUCKETS; k++) if (weight[k] > 0 && (best < 0 || weight[k] > weight[best])) best = k
  const pixels = rgb.length / 3
  // A few stray coloured pixels aren't the artwork's colour.
  if (best < 0 || weight[best] < pixels * 0.03) return null
  const hue = ((Math.atan2(hueY[best], hueX[best]) * 180) / Math.PI + 360) % 360
  const s = Math.min(0.85, Math.max(0.45, sat[best] / weight[best]))
  // Mid lightness: bright enough to glow on black, dark enough under white text.
  return hslToHex(hue, s, 0.5)
}
