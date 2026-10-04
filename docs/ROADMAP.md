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
   public, no extra servers to run (no relay VM). Speed via direct
   connections and hardware transcoding. Public HTTPS is an optional later
   add-on for other hosts.
4. **Users: Jellyfin/Emby model.** No public sign-up and no central account
   service. The host admin creates each user, which generates a one-time
   login code/QR; the friend signs in with it and the device keeps its own
   revocable key. Per-user watch history and profiles ship with remote
   access (Phase 1), not with the redesign.
5. **Redesign last:** the vibrant/modern UI overhaul (Phase 8) starts after
   Phases 1–7 are built. The colours, type and spacing rules are agreed
   earlier (Phase 2) so new apps are built in the new style from the start.
6. **Native Mac app:** deferred — decide later (see Open questions).
7. **Order follows who uses MartBox (2026-10-02):** friends and family mostly
   use Apple devices and Fire TV sticks, some a web browser. So: finish
   remote access with iPhone/Apple TV sign-in first; the Fire TV app before
   the Android phone layout; audio types back-to-back (shared player);
   retro games, the biggest and riskiest step, last of the media types.

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
2. **No relay servers to run.** The reference host tested ideal for direct
   connections (no CGNAT, easy NAT, IPv6, UPnP). A friend who still ends up
   on Tailscale's shared relay gets lower quality instead of buffering. A
   self-hosted relay or Headscale (e.g. on a free cloud VM) was considered
   and dropped — not worth maintaining extra infrastructure (2026-10-02).
3. **Adaptive bitrate + hardware transcoding** (jellyfin-ffmpeg, encoder
   probing) so slow paths degrade quality instead of buffering. Host upload
   bandwidth is the hard ceiling.
4. **Seamless UX:** admin-created users sign in with a one-time login code /
   QR from host Settings → Users (per-device keys in Keychain/Keystore),
   friends never see Tailscale, instant reconnect, one plain-English status
   line in host Settings.
5. **Public HTTPS (optional later):** Plex-style direct HTTPS for other
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
| 1 | Remote access v2 — in this order: users/login codes ✓, Tailscale speed ✓, iPhone/Apple TV sign-in, dashboard v1, 4K/HDR + HW transcode, dashboard v2/v3 | all | 5–7 wks |
| 1c | Requests: friends request movies/shows in MartBox; admin handles them in the Dashboard (replaces RQSTMart) | iPhone, Apple TV, desktop; Fire TV with Phase 3 | 1–2 wks |
| 1b | Live Channels: your own TV network from the library (ErsatzTV-style always-on channels + guide) | iPhone, Apple TV, desktop; Fire TV with Phase 3 | 1–2 wks |
| 2 | Design foundations: colour palette, type, spacing rules (no restyle yet) | all | 2–4 days |
| 3 | Fire TV app first, then the Android phone layout (one codebase) | Fire TV, Android | 8–12 wks |
| 3b | Optional: MartBox Web for friends who already run Tailscale | browser | 1–2 wks |
| 4 | Music (lossless, gapless, background/lock-screen, CarPlay later) | all | 4–8 wks |
| 5 | Audiobooks & podcasts (reuses the music player) | phones/desktop (TV optional) | 2–4 wks |
| 6 | Ebooks & comics readers | phones/tablets/desktop (not TV) | 3–5 wks |
| 7 | Retro games | all | 8–12 wks |
| 8 | Redesign: apply the new look everywhere + minor features (below) | all | 4–8 wks |

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
- iOS/tvOS update via TestFlight/App Store; Android/Fire TV (Phase 3) gets an
  in-app "new version" prompt that downloads the APK.

**Phase 1 — Remote access v2.** See `REMOTE_ACCESS_PLAN.md`. Done when a
friend signs in with a login code, streams 1080p smoothly from outside the
house, and the dashboard shows their connection. Order: users/login codes
and security review (done), Tailscale speed and access rules (done),
iPhone/Apple TV sign-in (unblocks "require a login"), dashboard v1 (Now
Playing + Network, the measuring tool for the next part), 4K/HDR and
transcoding, dashboard v2/v3, then the dashboard on the admin's phone
(Now Playing with stop, requests to approve, network, server; iPhone build
18, server 0.11.0).

**Phase 1c — Requests (before 1b).** RQSTMart built into MartBox, so friends
need one app. Done when a friend requests a show from their iPhone, it
appears in the Dashboard, and once the show is added and scanned the friend
sees it as Available with a Play button.
- Requests tab in the apps: trending/popular/search via the server (it
  already talks to TMDB for the library, so no key ships in any app), detail
  page, request a movie or specific seasons of a show.
- Signed in with the MartBox login code already: no name entry, no separate
  Tailscale key. Titles already in the library show "On MartBox — Play";
  duplicates show "Already requested by …".
- Friends see their requests' status: Requested → Approved → Available
  (or Declined, with the admin's note).
- Dashboard Requests panel with a new-count badge: approve, decline (with a
  note), delete. A library scan that finds the title marks it Available
  automatically. No phone notifications; optionally a desktop notification
  on the server PC.
- Server: `requests` table (user, TMDB id, type, seasons, status, note,
  timestamps), TMDB browse/search endpoints for signed-in devices.
- RQSTMart (separate app, ntfy push) is retired once this ships.
- **Built** (server 0.8.0, iPhone build 16, Apple TV build 19): server
  `src/main/requests.ts`, desktop Requests page + Dashboard panel, iPhone
  and Apple TV Requests tabs. Fire TV gets it with Phase 3.

**Phase 1b — Live Channels.** Your own TV network, like ErsatzTV: always-on
custom channels made only from movies and shows already in the server's
library, which friends tune into mid-show, with a TV guide. No outside TV or
IPTV sources (the old Live TV proxy stays removed). Done when a friend opens the guide on an Apple TV, joins "Simpsons
24/7" partway through an episode, and channel up/down works with the remote.
- Admin builds channels in the desktop app: pick shows, collections, a
  genre or decade; shuffle or in order; optional time blocks ("cartoons
  7–11 am"), channel number and logo.
- The schedule is worked out from the clock (a fixed start time + the
  ordered items' lengths), so nothing runs while nobody watches; tuning in
  plays the current item from the right point and rolls on to the next.
- Reuses the Phase 1 streaming (direct play / remux / transcode, quality
  setting), so channels play as well as anything else.
- Apps: a Live tab with a guide grid (channels × time, now/next), channel
  up/down and an info banner on the remote. Fire TV gets it with Phase 3.
- Left on all day: nothing runs while nobody watches, but a channel left
  playing is a stream that never ends, so:
  - "Are you still watching?" after ~3 hours with no button pressed; the
    stream stops until someone answers (regular playback too).
  - Optional per-channel quality cap (e.g. 1080p or 720p) so a background
    channel doesn't stream 4K all day.
  - Dashboard shows who's on a channel, for how long and the upload it uses,
    with a stop button.
  - Viewers on the same channel at the same quality share one transcode.
- Filler between items (trailers, bumpers from the library) and a channel
  logo in the guide and the player's corner.
- **Built** (server 0.9.0, iPhone build 17, Apple TV build 20): schedule from
  the clock (`channelSchedule.ts`), channels from shows / movie filters with
  real file lengths (`channels.ts`), desktop Live page + editor + player,
  iPhone and Apple TV Live tabs (shared `LiveTuner`), quality cap, "Still
  watching?" after 3 h. Then (server 0.11.0, iPhone build 18, Apple TV
  build 21): time blocks, filler, logos, and viewers of a channel sharing
  one conversion.

**Phase 2 — Design foundations.** Done when the palette, type scale, spacing
and corner rules are written down as design tokens and shown on one sample
screen. No restyling of existing screens yet — it means the Fire TV app and
everything after it are built in the new style from the start.
- **Done** (2026-10-03): `design/tokens.json` + `docs/DESIGN.md`, and the
  design system page with a sample Home screen. Black base; the accent is
  a gradient the viewer picks from five presets (Blue default, Purple,
  Pink, Orange, Green), each with black labels on it so all pass
  contrast; 11 desktop and 8 TV text styles; a 4px spacing scale; five
  radii.
- Accent choice: Settings → Appearance, saved per profile on the server
  so it follows the person. Fire TV ships with it; desktop, iPhone and
  Apple TV get it when they move to the new style.
- Open: the app icon is still the purple cube.

**Phase 3 — Fire TV + Android.** Done when a friend on a Fire TV stick, then
on an Android phone, signs in with a code and streams remotely. Fire TV
comes first (friends use Fire TV sticks); the phone layout follows on the
same codebase.
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

**Phase 3b (optional) — MartBox Web.** For friends who'd rather use a
browser and already run Tailscale (a browser can't join the tailnet itself).
The host serves the app over HTTPS at its tailnet name (tsnet provides the
certificate); sign-in with a login code, key kept in the browser. Anyone
without Tailscale uses the desktop app instead — it is the web experience,
installed once. A public, nothing-installed web app (Plex-style) would need
the host reachable from the internet and stays out of scope.

**Phase 4 — Music.** Done when an album plays gapless in lossless at home and
keeps playing with the phone locked when away.
- Server: scan music folders, tags (artist/album/track/disc), album art.
- FLAC/ALAC/MP3/AAC/Opus; lossless at home, AAC/Opus when the remote path
  needs it.
- Artists/albums/tracks/genres views, search, playlists, per-user history.
- Gapless player with queue/shuffle/repeat; background + lock-screen
  controls on iOS and Android; desktop, tvOS and Fire TV too.
- Later: CarPlay (needs an Apple CarPlay entitlement) and Android Auto.

**Phase 5 — Audiobooks & podcasts.** Done when an audiobook resumes at the
same spot on a different device. Straight after music: it reuses the audio
player, background playback and library scanning.
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

**Phase 7 — Retro games.** Done when a GBA game plays on an iPhone with
on-screen controls, then continues from the same save on another device with
a controller. See "Retro games approach" above; also:
- Licence audit of every core before integrating.
- Server stores saves and save states per user.
- App Store review prep (guideline 4.7: emulators for user-owned games).

**Phase 8 — Redesign.** Done when all six platforms share the new look and
design rules (agreed in Phase 2). See below.

## Redesign (Phase 8, after everything else)

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

The design tokens are agreed in Phase 2, so screens built in Phases 3–7
already use them; this phase restyles what came before and adds the minor
features.

## Open questions
- Are friends connecting directly or relayed? (Relayed friends get capped
  quality; the Remote Access screen shows each friend's path.)
- Host upload bandwidth (caps simultaneous remote streams/bitrate).
- Optional later: a native SwiftUI Mac *client* sharing iOS code (the host
  server stays Electron).
