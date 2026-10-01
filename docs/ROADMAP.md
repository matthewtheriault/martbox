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
3. **Remote access:** make the host directly reachable first (UPnP / port
   forward, free). Oracle Always Free relay only if the host is behind CGNAT.

## Goals
- Everything **free to run** — no paid relays, servers, or subscriptions.
- **Seamless** for friends: pair with a code/QR, it just works at home and
  away, reconnects on its own.

## Scope

**In:** Movies & TV, music (incl. lossless), audiobooks & podcasts, ebooks
(EPUB/PDF), comics (CBZ/CBR/CB7), retro games, CD ripping.

**Out:** photos, home/personal videos, music videos, short-form video; Roku,
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

Only the **host** must be reachable — clients always dial out, so friends on
cellular/CGNAT/hotel Wi-Fi are fine once the host is.

1. **Host reachability (free):** UPnP/NAT-PMP auto port mapping from the app
   (fixed tsnet UDP port + HTTPS TCP port), manual-forward fallback with clear
   instructions in Settings. Makes Tailscale go direct instead of DERP.
2. **Tailscale free Personal plan** stays the transport short-term (existing
   sidecar, gomobile bridges, invite codes). Friend devices join as tagged
   devices. (Verify current free-plan limits before relying on this.)
3. **If host is behind CGNAT, or to drop the dependency on Tailscale Inc.:**
   Oracle Cloud Always Free VM running **Headscale** (self-hosted control
   server; tsnet supports a custom `ControlURL`) + a **self-hosted DERP
   relay**. $0, but with strings:
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
5. **Seamless UX:** Ampchor-style pairing (short code / QR shown on host,
   per-device keys in Keychain/Keystore), clients race LAN → direct →
   relayed paths automatically, auto-reconnect, one plain-English status line
   in host Settings.

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
| 1 | Remote access v2 (free path above + pairing + ABR + HW transcode) | all | 4–6 wks |
| 2 | Android + Fire TV app to parity with iOS for movies/TV | Android, Fire TV | 8–12 wks |
| 3 | Music (lossless, gapless, background/lock-screen, CarPlay later) | all | 4–8 wks |
| 4 | Retro games | all | 8–12 wks |
| 5 | Audiobooks & podcasts | phones/desktop (TV optional) | 3–5 wks |
| 6 | Ebooks & comics readers | phones/tablets/desktop (not TV) | 3–5 wks |
| 7 | CD ripping (FLAC/ALAC) | desktop host | 1–3 wks |

**Total: ~8–12 months.** The cost multiplier is that each media type ships
on 5–6 clients.

## Open questions
- Is the host behind CGNAT? (Decides whether Oracle-free relay is required.)
- Host upload bandwidth (caps simultaneous remote streams/bitrate).
- Optional later: a native SwiftUI Mac *client* sharing iOS code (the host
  server stays Electron).
