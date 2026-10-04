// Turns design/tokens.json into src/renderer/src/tokens.css: the colour,
// spacing, radius, size and shadow tokens as CSS custom properties, and one
// block per accent preset (`:root[data-accent="purple"]`) that the app sets
// from the person's choice. Run `npm run tokens` after editing tokens.json.
import { readFileSync, writeFileSync } from 'fs'

const tokens = JSON.parse(readFileSync('design/tokens.json', 'utf8'))
const themes = tokens.color.themes.map((t) => t.id)
const first = themes[0]

const valueFor = (token, theme) =>
  typeof token.value === 'string' ? token.value : (token.value[theme] ?? token.value[first])
const varRef = (v) => v.replace(/^\{(.+)\}$/, 'var(--$1)')

const lines = [
  '/* Generated from design/tokens.json by scripts/build-tokens.mjs — do not edit. */',
  '',
  ':root {'
]
for (const t of tokens.color.tokens) lines.push(`  --${t.name}: ${varRef(valueFor(t, first))};`)
for (const t of tokens.shadow.tokens) lines.push(`  --${t.name}: ${valueFor(t, first)};`)
for (const family of ['spacing', 'radius', 'size']) {
  for (const t of tokens[family].tokens) lines.push(`  --${t.name}: ${t.value};`)
}
lines.push('}')

// Only what differs from the first (default) preset.
for (const theme of themes.slice(1)) {
  lines.push('', `:root[data-accent='${theme}'] {`)
  for (const t of [...tokens.color.tokens, ...tokens.shadow.tokens]) {
    if (typeof t.value === 'string') continue
    const v = valueFor(t, theme)
    if (v !== valueFor(t, first)) lines.push(`  --${t.name}: ${varRef(v)};`)
  }
  lines.push('}')
}

writeFileSync('src/renderer/src/tokens.css', lines.join('\n') + '\n')
console.log(`wrote src/renderer/src/tokens.css (${themes.length} accent presets)`)
