// Files bundled as text (electron-vite's ?raw), e.g. the game player page.
declare module '*?raw' {
  const content: string
  export default content
}
