// The person's accent preset (design/tokens.json): set as data-accent on
// <html>, which tokens.css turns into the accent colours. Remembered on this
// computer so the app opens in it straight away, and saved to the profile on
// the server so it follows the person to every device.

export interface AccentPreset {
  id: string
  name: string
  start: string
  end: string
}

export const ACCENTS: AccentPreset[] = [
  { id: 'blue', name: 'Blue', start: '#5ac8fa', end: '#3b9eff' },
  { id: 'purple', name: 'Purple', start: '#a78bfa', end: '#e879f9' },
  { id: 'pink', name: 'Pink', start: '#f472b6', end: '#fb7185' },
  { id: 'orange', name: 'Orange', start: '#fb923c', end: '#facc15' },
  { id: 'green', name: 'Green', start: '#34d399', end: '#a3e635' }
]

const STORAGE_KEY = 'martbox.accent'

export function applyAccent(id: string | null): string {
  const accent = ACCENTS.find((a) => a.id === id)?.id ?? 'blue'
  document.documentElement.dataset.accent = accent
  try {
    localStorage.setItem(STORAGE_KEY, accent)
  } catch {
    // Not remembering it is harmless: the server has it.
  }
  return accent
}

export function rememberedAccent(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}
