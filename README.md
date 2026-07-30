# Ovrlook

A self-hosted, native desktop media server for your personal Movies and TV Shows library. Built with Electron + React. Scans your local library, fetches posters/metadata from TMDb, and gives you a Netflix/Plex-style browsing experience with watch history and Continue Watching — no subscription, no cloud.

## Features

- **Native desktop app** (Electron) — install and run directly on the PC where your media lives
- **Library scanning** — recognizes Movies (`Title (Year).ext`) and TV Shows (`Show S01E02.ext`) folder conventions
- **Metadata** — posters, backdrops, overviews, cast ratings, episode stills via [TMDb](https://www.themoviedb.org/)
- **Watch history & Continue Watching** — resumes exactly where you left off, marks watched/unwatched
- **Broad format support** — direct-plays MP4/H.264 natively; transparently transcodes MKV/AVI/HEVC/AC3/DTS and other formats on the fly via bundled FFmpeg
- **Modern UI** — sidebar navigation, hero banner, poster rows, season/episode browser

## Getting started (development)

Requirements: Node.js 20+.

```bash
npm install
npm run dev
```

This launches the app in development mode with hot reload.

### TMDb API key

Metadata lookups require a free TMDb API key:

1. Create an account at https://www.themoviedb.org/
2. Go to **Settings → API** and request a free "Developer" API key (v3 auth)
3. Open Ovrlook → **Settings** → paste the key under "TMDb API Key" → Save

### Adding your library

1. Open **Settings**
2. Choose **Movies** or **TV Shows**, click **Add Library Folder**, and pick the folder on disk
3. Click **Scan** next to the library — this walks the folder, identifies video files, and matches each one against TMDb

Expected folder conventions:

- **Movies**: `Movies/Inception (2010)/Inception (2010).mkv` or `Movies/Inception (2010).mkv`
- **TV Shows**: `TV/Breaking Bad/Breaking.Bad.S01E01.mkv` (a subfolder per show; season subfolders are fine too)

## Building an installer

```bash
npm run build:win     # Windows NSIS installer (.exe)
npm run build:mac     # macOS .dmg
npm run build:linux   # Linux AppImage/.deb
```

Output lands in `release/`. Note: building a Windows installer from macOS/Linux typically requires Wine; the included GitHub Actions workflow (`.github/workflows/build-windows.yml`) builds the Windows installer natively on a `windows-latest` runner instead — push to `main` or trigger it manually from the **Actions** tab, then download the artifact (or grab it from a tagged release, e.g. `git tag v0.1.0 && git push --tags`).

## Architecture

- `src/main` — Electron main process: SQLite database (`better-sqlite3`), library scanner, TMDb client, local Express server (streaming + image cache), IPC handlers
- `src/preload` — typed `contextBridge` API exposed to the renderer as `window.api`
- `src/renderer` — React UI (sidebar, hero, poster rows, detail pages, player, settings)
- `src/shared` — types shared between main and renderer

All app data (SQLite DB, cached poster/backdrop images) lives in the OS-standard Electron `userData` directory — nothing is written into your media folders.

### Playback

Video is served from a local HTTP server (`127.0.0.1`, random port) that Electron talks to directly:

- Files that are already MP4/H.264/AAC are served with HTTP range support for native seeking (direct play).
- Everything else (MKV, AVI, HEVC, AC3/DTS audio, etc.) is transcoded on the fly with a bundled FFmpeg binary. Seeking during transcoded playback restarts the stream at the requested offset (shown as `-30s`/`-10s`/`+10s`/`+30s` controls under the video) rather than using the native scrubber, since the transcoded stream doesn't expose a byte-seekable duration.

## Known limitations (v1)

- Scanner filename parsing covers the common `Title (Year)` and `SxxEyy` conventions; unusual naming may need a manual rename
- No hardware-accelerated transcoding yet (CPU `libx264` encode when direct play isn't possible)
- Single local user — no multi-user profiles/PINs yet
