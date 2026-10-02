import { app } from 'electron'

// Dev-only: MARTBOX_USER_DATA_DIR points an unpackaged run at a throwaway
// data folder (database, Tailscale state, caches), so testing never touches
// a real install's data. Must be imported before anything that reads
// userData — index.ts imports it first. Ignored in packaged builds.
if (!app.isPackaged && process.env.MARTBOX_USER_DATA_DIR) {
  app.setPath('userData', process.env.MARTBOX_USER_DATA_DIR)
}
