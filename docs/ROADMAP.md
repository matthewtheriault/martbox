# MartBox Roadmap (draft)

Status: **planning.** Inspired by
[Ampchor](https://ampchor.com/) — a "your computer is your streaming service"
app covering video, music, books, comics, games, with paid remote access.
See also `REMOTE_ACCESS_PLAN.md` in this folder.

## Decisions

1. **License: GPLv3** (see `LICENSE`). Unlocks GPL emulator cores. Audit every core's license before integrating
   (GPLv2-only cores and Snes9x's non-commercial license are not GPLv3-
   compatible — use bsnes or another GPL-compatible SNES core instead).
2. **Launch consoles:** GB/GBC/GBA, NES, SNES, N64, NDS, PS1. Later:
   GameCube (Android + desktop only). PS2 skipped for now.
3. **Remote access: Tailscale is the main path** — no router changes, nothing
   public. Speed via direct connections, our own Tailscale peer relay on a
   free Oracle VM if friends are relayed, and hardware transcoding. Public
   HTTPS is an optional later add-on for other hosts.
4. **Users: Jellyfin/Emby model.** No public sign-up and no central account
   service. The host admin creates each user, which generates a one-time
   login code/QR; the friend signs in with it and the device keeps its own
   revocable key. Per-user watch history and profiles ship with remote
   access (Phase 1), not with the redesign.
5. **Redesign last:** the vibrant/modern UI overhaul (Phase 7) starts after
   Phases 1–6 are built.
6. **Native Mac app:** deferred — decide later (see Open questions).

## Goals
- Everything **free to run** — no paid relays, servers, or subscriptions.
- **Seamless** for friends: pair with a code/QR, it just works at home and
  away, reconnects on its own.

## Scope

**In:** Movies & TV, music (incl. lossless), audiobooks & podcasts, ebooks
(EPUB/PDF), comics (CBZ/CBR/CB7), retro games.

**Out:** photos, home/personal videos, music videos, short-form video, CD
ripping (dropped 2026-10-02 — not needed); Roku,
Samsung (Tizen), LG (webOS).

**Platforms:**
| Platform | Role | Tech | Distribution |
|---|---|---|---|
| Windows | host + client | Electron (this repo) | unsigned installer (SmartScreen warning on first run) |
| macOS | host + client | Electron (this repo, incl. a `mas` Mac App Store target) | notarized DMG and/or Mac App Store |
| iOS | client | SwiftUI (separate repo) | TestFlight/App Store — **requires $99/yr Apple Developer Program**; free signing = 7-day reinstalls |
| tvOS | client | SwiftUI (separate repo) | same as iOS |
| Android | client | Kotlin + Jetpack Compose (new) | sideloaded APK (Play Store optional, $25 one-time) |
| Fire TV | client | same Android codebase, Compose for TV layout | sideloaded APK |

The Apple Developer Program fee is the only unavoidable cost.

## Free remote access strategy

**Tailscale is the main path** — no router changes on the host (it shares a
family router), nothing exposed to the open internet. Details in
`REMOTE_ACCESS_PLAN.md`.

1. **Tailscale free Personal plan** is the transport (existing sidecar,
   gomobile bridges, invite codes). Friend devices join as tagged devices,
   locked down by access rules. Tailscale hole-punches directly in most
   cases, with no port forwarding.
2. **Our own peer relay when needed:** if friends end up relayed, a
   Tailscale **peer relay** (free on the Personal plan) on an Oracle Cloud
   Always Free VM replaces the slow shared DERP relays. The VM's port is
   opened in Oracle's cloud firewall, not on the home router.
3. **To drop the dependency on Tailscale Inc. (later, optional):**
   the same Oracle VM could run **Headscale** (self-hosted control
   server; tsnet supports a custom `ControlURL`) + a **self-hosted DERP
   relay**. Oracle Always Free is $0, but with strings:
   - Card required at signup; 10 TB/mo outbound free.
   - Idle reclaim: free instances can be stopped if, over 7 days, 95th-pct
     CPU, network, and (A1) memory are all under 20% — a mostly-idle relay
     fits that. Upgrading the account to Pay-As-You-Go exempts it (still $0
     inside Always Free limits, but a card is on file).
   - A1 ARM capacity is often unavailable in popular regions; reportedly
     reduced from 4 OCPU/24 GB to 2 OCPU/12 GB in June 2026 (plenty for a
     relay either way).
   - Treat it as an optional fallback, never the primary path.
4. **Adaptive bitrate + hardware transcoding** (jellyfin-ffmpeg, encoder
   probing) so slow paths degrade quality instead of buffering. Host upload
   bandwidth is the hard ceiling.
5. **Seamless UX:** admin-created users sign in with a one-time login code /
   QR from host Settings → Users (per-device keys in Keychain/Keystore),
   friends never see Tailscale, instant reconnect, one plain-English status
   line in host Settings.
6. **Public HTTPS (optional later):** Plex-style direct HTTPS for other
   hosts who can open a router port. Not planned for our host.

## Retro games approach

Decisions: on-screen GBA-style controls by default on
phones/tablets; physical controllers (wired or Bluetooth, paired in the OS)
supported everywhere, on-screen overlay auto-hides when one connects.

| System | Core | iOS | tvOS | Android | Fire TV | Win/Mac |
|---|---|---|---|---|---|---|
| GB / GBC / GBA | mGBA | ✓ | ✓ | ✓ | ✓ | ✓ |
| NES / SNES | FCEUmm / bsnes (or other GPL-compatible) | ✓ | ✓ | ✓ | ✓ | ✓ |
| N64 | Mupen64Plus-Next | ✓ (no JIT, OK on recent iPhones) | ✓ | ✓ | 4K Max only | ✓ |
| NDS | melonDS | ✓ (touch bottom screen) | ✗ (no touch) | ✓ | ✗ (no touch) | ✓ |
| PS1 | PCSX ReARMed / SwanStation | ✓ | ✓ | ✓ | ✓ | ✓ |
| PSP (optional) | PPSSPP | ✓ | ✓ | ✓ | ✗ | ✓ |
| GameCube | Dolphin | ✗ needs JIT | ✗ | ✓ decent phones | ✗ too weak | ✓ |
| PS2 | PCSX2 / LRPS2 | ✗ | ✗ | ✗ (no maintained open option) | ✗ | ✓ desktop later |

- Frontends: native libretro frontend in Swift (shared iOS/tvOS), Kotlin +
  NDK (shared Android/Fire TV), EmulatorJS or native libretro in Electron.
- Controllers: Apple GameController framework (Xbox, DualShock/DualSense,
  Switch Pro, MFi; USB-C wired on iPad/iPhone 15+/Mac); Android InputDevice
  (any HID gamepad, BT or USB OTG); remapping UI on all.
- Licensing: MartBox is GPLv3 (see Decisions). mGBA (MPL 2.0) is
  compatible; Snes9x is not (non-commercial clause) — use a GPL-compatible
  SNES core. Verify each core is GPLv3-compatible ("v2 or later", not
  "v2 only") before integrating.
- MartBox ships no games or system firmware. Users add their own legally
  obtained game backups (e.g. dumped from cartridges/discs they own); App
  Store guideline 4.7 permits emulators on that basis. PCSX ReARMed has a
  built-in HLE BIOS, so PS1 needs no firmware file.

- Host stores the user's game files + saves; clients **copy the game file to the device and emulate locally**
  (no gameplay video streaming — avoids latency/bandwidth issues remotely).
- Emulation via **libretro** cores; **EmulatorJS** (libretro → WASM) runs
  inside Electron and possibly in WebViews on iOS/tvOS/Android for maximum
  code reuse. (GPL — fine for a free personal project.)
- No JIT on iOS/tvOS: fine through ~PS1 era, heavier systems may struggle.
- Controller support on all platforms; save states synced back to host.

## Phases & rough sizing (solo dev + Claude; estimates, not commitments)

| # | Phase | Clients | Size |
|---|---|---|---|
| 0.5 | In-app updates (electron-updater + GitHub Releases, backup before install, server/app version check) | Windows, macOS | 1 session |
| 1 | Remote access v2 (Tailscale speed + peer relay + users/login codes + 4K/HDR direct play, quality ladder, HW transcode + server dashboard) | all | 5–7 wks |
| 2 | Android + Fire TV app to parity with iOS for movies/TV | Android, Fire TV | 8–12 wks |
| 3 | Music (lossless, gapless, background/lock-screen, CarPlay later) | all | 4–8 wks |
| 4 | Retro games | all | 8–12 wks |
| 5 | Audiobooks & podcasts | phones/desktop (TV optional) | 3–5 wks |
| 6 | Ebooks & comics readers | phones/tablets/desktop (not TV) | 3–5 wks |
| 7 | Redesign: vibrant, sleek modern UI + minor features (below) | all | 4–8 wks |

**Total: ~9–14 months.** The cost multiplier is that each media type ships
on 5–6 clients.

With Claude doing most of the coding, closer to 2–4 months — set mostly by
real-device and real-network testing time.

## Phase details

Each phase has a "done when" test; checklists also live in the MartBox Plan
doc.

**Phase 0.5 — In-app updates.** Done when a Windows host and a Mac client
both pick up a new release by themselves and keep all their data. See
`RELEASING.md`.
- electron-updater with GitHub Releases on the public repo; check on launch
  and every 6 h, download in the background, install on restart (Settings →
  App Updates or the tray).
- Database backup when an update finishes downloading and again before it
  installs; user data stays in the user-data folder.
- Mac `.zip` target for the updater; notarization when Apple credentials are
  set; Windows CI attaches `latest.yml` + blockmap to tagged releases.
- Host `GET /api/version` + `API_VERSION`; client apps show "update the
  server" / "update this app" on a mismatch.
- iOS/tvOS update via TestFlight/App Store; Android (Phase 2) gets an
  in-app "new version" prompt that downloads the APK.

**Phase 1 — Remote access v2.** See `REMOTE_ACCESS_PLAN.md`. Done when a
friend signs in with a login code, streams 1080p smoothly from outside the
house, and the dashboard shows their connection.

**Phase 2 — Android + Fire TV.** Done when a friend on an Android phone and
on a Fire TV stick signs in with a code and streams remotely.
- New private repo, like the iOS/tvOS apps.
- **Tailscale bridge for Android:** build tsnet with gomobile (stock gomobile
  supports Android; the iOS/tvOS `TsnetBridge` is Apple-only).
- Sign-in: QR scan on phones, short code entry with the Fire TV remote.
- Home, Movies, TV Shows, detail pages, search, watchlist, profile picker.
- Player on Media3/ExoPlayer: resume, subtitles, audio tracks; reports
  HEVC/HDR support to the server for per-device direct play.
- Fire TV layout with Compose for TV and D-pad navigation.
- Instant reconnect on foreground.
- Signed APK + sideload steps (Fire TV via the Downloader app); Play Store
  optional ($25 one-time).

**Phase 3 — Music.** Done when an album plays gapless in lossless at home and
keeps playing with the phone locked when away.
- Server: scan music folders, tags (artist/album/track/disc), album art.
- FLAC/ALAC/MP3/AAC/Opus; lossless at home, AAC/Opus when the remote path
  needs it.
- Artists/albums/tracks/genres views, search, playlists, per-user history.
- Gapless player with queue/shuffle/repeat; background + lock-screen
  controls on iOS and Android; desktop, tvOS and Fire TV too.
- Later: CarPlay (needs an Apple CarPlay entitlement) and Android Auto.

**Phase 4 — Retro games.** Done when a GBA game plays on an iPhone with
on-screen controls, then continues from the same save on another device with
a controller. See "Retro games approach" above; also:
- Licence audit of every core before integrating.
- Server stores saves and save states per user.
- App Store review prep (guideline 4.7: emulators for user-owned games).

**Phase 5 — Audiobooks & podcasts.** Done when an audiobook resumes at the
same spot on a different device.
- Server: audiobooks (M4B/MP3, chapters, covers, author/narrator); podcasts
  via RSS subscriptions the server downloads.
- Chapters, playback speed, sleep timer, skip forward/back, background
  playback, per-user position sync, offline downloads. TV optional.

**Phase 6 — Ebooks & comics.** Done when a comic opened on an iPad picks up on
the same page on a phone.
- Server: EPUB/PDF/CBZ/CBR/CB7, covers, series, authors.
- EPUB reader (font size, light/dark/sepia, reflow), PDF viewer, comic
  viewer (single/two-page, right-to-left manga mode, zoom).
- Per-user reading progress sync, offline downloads. Not on TV.

**Phase 7 — Redesign.** Done when all six platforms share the new look and
design rules. See below.

## Redesign (Phase 7, after everything else)

Draft direction — to be refined before starting.

**Look & feel**
- Dark near-black base with **vibrant accent gradients**, one per media
  type (e.g. movies/TV magenta→orange, music cyan→blue, games lime→green,
  books amber).
- **Artwork-driven colour:** backgrounds and buttons tint from the current
  poster / album cover.
- Frosted-glass panels, large edge-to-edge hero artwork, rounded cards,
  smooth motion and transitions.
- Light mode + an accent-colour picker in Settings.
- One shared set of **design tokens** (colour, type, spacing, radius)
  implemented in Electron (CSS), SwiftUI and Compose so all six platforms
  look like one product.

**Minor features to ship with it**
- Continue Watching / Up Next synced across devices (data exists from
  Phase 1; this is the polished UI).
- Skip intro/credits, sleep timer.
- Profile avatars and profile-picker design, custom collections.
- Keyboard-shortcut search / command palette and more shortcuts on desktop.
- "Year in review" stats screen.
- Trailers on movie/show pages.

Note: screens built in Phases 2–6 will be restyled here. Agreeing the design
tokens before Phase 2 would reduce that rework (optional).

## Open questions
- Are friends connecting directly or relayed? (Decides whether the Oracle
  peer relay is needed.)
- Host upload bandwidth (caps simultaneous remote streams/bitrate).
- Optional later: a native SwiftUI Mac *client* sharing iOS code (the host
  server stays Electron).
