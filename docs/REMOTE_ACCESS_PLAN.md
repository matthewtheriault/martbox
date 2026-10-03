# Remote Access v2 — Plan (draft)

Status: **planning.** Main path: **Tailscale.** Public HTTPS is an optional
later add-on (see the end of this doc).

## Why

Today, remote friends reach MartBox over Tailscale (the tsnet sidecar in
`sidecar/main.go`, plus the gomobile `TsnetBridge` in the iOS/tvOS apps). It
works, but streaming is often slow. The likely cause: when two peers can't
punch a direct path, Tailscale falls back to its shared DERP relays, which are
throttled and not meant for sustained video. Setup is also fiddly for friends
(invite keys minted via a Tailscale API token), and on iOS the in-process
tunnel dies when the app is backgrounded.

**Why Tailscale stays the main path:** the host shares a home router with
family, so the plan must need **no router changes** (no port forwarding, no
manual UPnP setup) and must not expose anything to the open internet.
Tailscale gives that, end-to-end encrypted, for free.

Goal: **one login code for friends, near-direct speed for everyone, no
router work** — by making Tailscale connect directly more often, replacing
the slow shared relays with our own fast one when needed, and fitting the
video to the connection.

## Recommended setup

**Tailscale for transport, hardware transcoding everywhere, no extra
servers to run.** $0 for the host and every friend.

**Host setup (one-time)**
1. Install MartBox, add media folders.
2. Settings → Remote Access: connect Tailscale (existing API-token flow).
   The app joins the tailnet, applies the recommended access rules, and
   shows a plain-English status ("Friends connect directly ✓").
3. Settings → Users → Add user → one-time login code / QR to send the friend.

**Friend setup:** install the app (iPhone, Apple TV, Android, Fire TV,
computer), enter or scan the code. The app joins the tailnet in the
background and stays signed in with its own history. Friends never install
Tailscale or see it.

**On play:** the host picks the quality that fits the path (direct play when
there's room, otherwise a hardware transcode), so slow paths drop quality
instead of buffering.

**Expected speed by path**

| Path Tailscale finds | When it happens | Speed |
|---|---|---|
| Direct (hole-punched, IPv4 or IPv6) | Most home and mobile networks, including many CGNATs | Full — limited only by host upload |
| Tailscale shared DERP relay | Both sides behind strict NAT (rare — the reference host tested ideal for direct) | Slow — auto-capped to 480p–720p |

**Why this design**
- **No router changes, nothing public:** only outbound connections from the
  house; nothing new exposed to the internet.
- **Free, nothing extra to maintain:** Tailscale Personal plan and
  jellyfin-ffmpeg; no relay VM or other servers.
- **Seamless:** friends just enter a code.
- **Fast:** direct in almost every case; the rare relayed friend gets lower
  quality instead of buffering.
- Trade-offs: friend devices join the tailnet (locked down by access
  rules); we depend on Tailscale's free plan; iOS backgrounding needs
  careful reconnect handling (Phase 3).

## How to make Tailscale faster

Speed comes from three things, in order of impact:

1. **Get a direct path more often (no router work)**
   - Tailscale already tries hole-punching over IPv4 and IPv6 and asks the
     router for a mapping automatically via UPnP/NAT-PMP/PCP *if the router
     allows it* — nothing for the host to configure. (If the family wants
     that off, tsnet can disable its port mapper — verify the knob.)
   - Keep the fixed tsnet UDP port from Phase 0: a stable port helps NAT
     mappings stay consistent.
   - Keep `tailscale.com` (tsnet) current in `sidecar/go.mod` and in the
     gomobile bridges — NAT traversal and netstack throughput improve
     between releases.
2. **Fit the video to the path** (Phase 4)
   - Direct play when the path has room; otherwise hardware transcode to a
     bitrate that fits. Relayed or slow paths degrade quality instead of
     buffering.
3. **Make the streaming itself efficient** (Phase 4)
   - HTTP keep-alive and range requests, a bigger read-ahead buffer on
     clients, and HLS segments for transcodes so playback starts fast and
     adapts.
   - Cap simultaneous remote streams to what the host's upload can carry.

Measure before and after each change (Phase 0 diagnostics + a throughput
test), so we only do the work that actually helps.

## Login codes

Login code (invite v2) sketch:

```ts
interface InviteCodeV2 {
  v: 2
  name: string            // server display name
  loginCode: string       // one-time, expires after first use or 24–48 h
  tailscale: { authKey: string; hostAddr: string; port: number }
  publicUrl?: string      // reserved for the optional public HTTPS path
}
```

The client joins the tailnet with the one-time, tagged Tailscale auth key,
then redeems `loginCode` once (`POST /api/auth/redeem` with a device name)
and gets back a long-lived **device key** for that user, stored in the
Keychain (Apple) / Keystore (Android) / `safeStorage` (Electron). Every later
request sends the device key; the login code is useless after redemption.

## Phases

**Build order (2026-10-02):** Phase 0 ✓ → Phase 1 users ✓ → Phase 2
Tailscale speed ✓ → **Phase 3 iPhone/Apple TV sign-in** (unblocks "require a
login") → dashboard v1 (Now Playing + Network) → Phase 4 4K/HDR → dashboard
v2/v3.

**Done when** a friend signs in with a login code, streams 1080p smoothly
from outside the house, and the dashboard shows their connection.

### Phase 0 — Diagnose (no router changes)
- Surface in Settings whether each Tailscale peer is **direct or relayed**
  (tsnet `LocalClient().Status()` → peer `CurAddr` vs `Relay`; emit it from
  the sidecar's JSON status stream). *(PR #1, needs testing.)*
- Fixed tsnet UDP port 41642. *(PR #1.)* No manual forwarding — Tailscale
  uses it for automatic mapping only if the router allows.
- Run `tailscale netcheck` on the host: reports UDP, IPv6, NAT type ("mapping
  varies by destination" = hard NAT) and nearest DERP. Replaces the manual
  CGNAT check.
- Measure host upload bandwidth **on the server PC itself**, several times
  incl. busy evenings; plan around the lowest result. Note whether its
  Wi-Fi is on 5 GHz or 2.4 GHz.
- Add a per-friend **throughput test** (time a fixed-size download over the
  tailnet) next to the direct/relayed status.

### Phase 1 — Users & auth on the media server
- The Express server in `src/main/mediaServer.ts` currently has **no auth**;
  it relies on loopback/tailnet isolation. Tailscale ACLs are the first
  layer; per-user auth is the second, and gives each friend their own data:
  - **Builds on the existing profiles** in `src/main/db.ts` (name, avatar,
    optional PIN, `is_admin`, per-profile watch progress). Today a request
    just names a `profileId` (+ PIN if set) — there's no session tying a
    device to a profile. Phase 1 turns profiles into real users.
  - **Server-local users** (Jellyfin/Emby model, no sign-up, no central
    service — free). Settings → Users: admin creates a user (name, avatar,
    optional limits: remote access on/off, max content rating), which
    generates a **one-time login code** + QR. The host's own user is the
    admin.
  - Redeeming a login code creates a **device key** for that user (SQLite,
    hashed at rest). Admin can see each user's devices, sign one out,
    disable a user, or issue a new login code (e.g. new phone). Disabling a
    user also removes their tailnet devices via the Tailscale API.
  - **Per-user data:** watch progress, Continue Watching, watchlist (and
    later music history, game saves) — already per-profile; extend as
    needed.
  - Existing **profile PINs** stay for shared devices (e.g. a living-room
    Apple TV with a profile picker), now checked server-side per session.
  - Middleware checking `Authorization: Bearer <device key>` on all `/api/*`, `/stream/*`,
    `/probe/*`, `/image`, `/live/*` routes.
  - Players can't always set headers on media requests (AVPlayer, `<video>`
    src), so also accept a short-lived signed query param on media URLs.
  - Rate-limit failed auth attempts.
- Keep the loopback listener (`127.0.0.1`, used by the local renderer)
  unauthenticated or auto-authenticated; the **tailnet listener** always
  enforces auth.

### Phase 2 — Tailscale speed & hardening
- **Access rules:** the app checks the tailnet policy and offers a one-click
  recommended policy: `tag:martbox-guest` devices may reach **only**
  `tag:martbox-host` on the MartBox port; nothing else.
- Guest auth keys stay one-time, tagged, preauthorized, **non-ephemeral**
  (already the case in `src/main/tailscaleApi.ts` — ephemeral nodes would
  burn the free plan's ephemeral-minutes allowance).
- Update `tailscale.com` in the sidecar (done: v1.104.0) and in the gomobile
  bridges (with Phase 3, when the iOS/tvOS apps are rebuilt).
- Per-friend speed test: each signed-in device measures latency and
  download speed from the host and reports it; Settings → Users shows it.
- No relay VM: dropped 2026-10-02 (no extra infrastructure). Relayed
  friends get capped quality (Phase 4).
- Experiment (measure first): if the host already runs the system Tailscale
  app, compare serving over it vs tsnet's userspace networking; switch only
  if it's clearly faster.

### Phase 3 — Clients: login codes + seamless reconnect
- Sign-in screen on every client: enter or scan a login code, join the
  tailnet, redeem the code, store the device key; profile picker if the
  device has several users.
- Desktop client mode (`src/main/remoteClient.ts`): accept v2 codes, send
  the device key on every request; use the LAN address when on the same
  network.
- iOS/tvOS clients (separate repos): `ServerConfig` / `APIClient` learn the
  device key; `TsnetClient` restarts instantly on foreground, reusing its
  persisted node state (no re-auth), with a short "Reconnecting…" state
  instead of an error. Playback resumes from position.
- tvOS: a short code that is easy to enter with the Siri Remote (no QR
  scanning on a TV).
- Keep v1 invite codes working during transition.
- Real-iPhone test of the tsnet tunnel (so far Simulator only).
- Ship the new iOS/tvOS builds to friends via TestFlight or the App Store.

### Phase 4 — Hardware transcoding, 4K/HDR + efficient streaming

**Already built** (`src/main/mediaServer.ts`, `src/main/ffprobe.ts`):
- Hardware *encoder* detection at startup — `h264_nvenc` / `h264_qsv` /
  `h264_amf`, each proven with a tiny test encode, falling back to
  `libx264`. The bundled `ffmpeg-static` does include these encoders
  (benchmarked: `h264_amf` ~5× realtime on a 1080p30 source).
- Direct play for H.264 + AAC/MP3 in MP4/M4V/MOV; H.264 in other containers
  (e.g. MKV) is remuxed (`-c:v copy`), audio converted to AAC.
- Fragmented MP4 output with a keyframe every 2 s.
- **Per-device direct play** (`src/main/playback.ts`, `GET /api/playback`):
  the iPhone and Apple TV apps send what they decode (H.264/HEVC, 10-bit,
  Dolby Vision, max height, audio codecs) and a speed test result. The
  server answers with the original as-is (compatible MP4/MOV), the original
  **remuxed** to fragmented-MP4 HLS (MKV; video untouched incl. 4K HDR,
  audio copied or converted to E-AC-3 5.1), or a transcode — and why. If a
  device can't play what it's given it asks again, ruling that way out.
- **Remux HLS** (`src/main/hls.ts`): segments cut at the source's own
  keyframes, read from the MKV's index (`src/main/mkvKeyframes.ts`); runs
  pause when far ahead of the viewer so a big file isn't copied into the
  cache all at once.
- **Quality ladder:** 1080p ~8 Mbps / 720p ~4 Mbps / 480p ~1.5 Mbps
  (H.264), picked to fit the measured speed with 50% headroom; the viewer
  can choose Automatic / Original / a size in the app's Settings.

**Gaps today**
- **The desktop app** still uses the older rule (H.264 MP4 direct, anything
  else transcoded at source size) — move it to `/api/playback` too.
- **No HDR → SDR tone mapping:** HDR sources transcoded for SDR screens look
  washed out (or the encode fails on 10-bit input).
- **Decoding is software-only** (no `-hwaccel`), so 4K HEVC decode lands on
  the CPU.
- **Transcodes downmix audio to stereo** (`-ac 2`) — 5.1 survives only on
  the original/remux paths.
- **No VideoToolbox** in the encoder list, so macOS hosts always encode in
  software.

**To build**
1. ~~**Per-device direct play.**~~ Done for iPhone/Apple TV (above). Clients report what they can play (codecs incl.
   HEVC/HDR10/Dolby Vision, max resolution, audio channels). If the device
   supports the source and the path has the bandwidth: send it as-is, or
   **remux** MKV → fragmented MP4 with `-c:v copy` (`-tag:v hvc1` for HEVC on
   Apple). Zero quality loss, near-zero host load. This is the default for
   4K whenever possible.
2. ~~**Quality ladder with downscaling:**~~ Done for H.264 (above). Original → 1080p (~8–10 Mbps H.264 /
   ~5–6 Mbps HEVC) → 720p (~3–4 Mbps) → 480p (~1.5 Mbps). Picked per friend
   from the measured path (Phase 0 throughput test) and the host's upload;
   viewer can override.
3. **HEVC output** for devices that support it — same quality at ~40% less
   bitrate, so the host's upload carries more streams.
4. **HDR → SDR tone mapping** when transcoding HDR for an SDR device (GPU
   tone mapping via OpenCL in jellyfin-ffmpeg; CPU `zscale`+`tonemap`
   fallback).
5. **Hardware decoding** (`-hwaccel d3d11va` on Windows, `videotoolbox` on
   macOS, `vaapi` on Linux), with the frames kept on the GPU through
   scale/tone-map/encode where the driver allows.
6. **Surround audio:** pass 5.1 through (or encode AC3/EAC3 5.1) when the
   device supports it; stereo AAC otherwise.
7. **VideoToolbox** (`h264_videotoolbox` / `hevc_videotoolbox`) added to the
   encoder probe for macOS hosts.
8. Consider **jellyfin-ffmpeg** portable builds if `ffmpeg-static` lacks
   what 4–5 need (OpenCL tone mapping, newer AMF/QSV features).
9. **Efficient streaming:** HLS segments for transcodes (segments in RAM or
   on a data drive, never the small system SSD), larger client read-ahead
   buffers, cap simultaneous remote streams by upload. Longer term:
   multi-rendition HLS so players adapt automatically.

**What decides how a 4K file plays**

| Situation | Result |
|---|---|
| 4K-capable device, at home, supports the codec/HDR | Sent as-is (or remuxed) — full 4K HDR, no host load |
| Same, remote, host upload comfortably above the file's bitrate | Sent as-is — full 4K |
| Remote, upload too slow (typical for 40–80 Mbps disc rips) | Transcoded to 1080p (tone-mapped if the screen is SDR) |
| Device can't play HEVC | Transcoded to H.264, downscaled to fit |

Resolution alone never forces a transcode — the codec support and the
bitrate vs the path do.

### Reference host hardware

The dev/reference host: AMD Ryzen 5 5500 (6C/12T, no integrated GPU),
AMD Radeon RX Vega 56, 32 GB RAM, small NVMe system SSD, 4 × 4–6 TB HDDs for
media, Windows, **Wi-Fi** to the router.

| Part | Role | Notes |
|---|---|---|
| Vega 56 | All hardware video work | Decodes H.264 and HEVC incl. 4K 10-bit HDR; encodes H.264 + HEVC (8-bit) via AMF; strong enough for OpenCL tone mapping. **No hardware AV1 or VP9 decode** |
| Ryzen 5 5500 | Server, DB, audio, fallback | Software-decodes AV1/VP9 sources; software encode as last resort |
| 32 GB RAM | Plenty | Room to hold HLS segments in memory |
| NVMe system SSD | DB, image cache | Small — keep transcode/segment output off it |
| 4 × HDD | Media | 80 Mbps (≈10 MB/s) per 4K remux stream is a small fraction of HDD throughput. Drive spin-down can add a few seconds at play start |

**Rough concurrent capacity** (estimates — the dashboard will show real
numbers):

| Stream type | Concurrent streams |
|---|---|
| Direct play / remux (incl. 4K) | Many — limited by upload, not hardware |
| 1080p HEVC → 1080p H.264 | ~4–6 |
| 4K HDR → 1080p SDR (scale + tone map) | ~2–3 |
| 4K → 4K re-encode | ~1 — avoid; direct-play instead |

**Host-specific notes**
- Prefer **HEVC output** to supporting devices to stretch upload.
- AMD's older AMF H.264 encoder is weaker at very low bitrates — prefer
  stepping down to 720p over squeezing 1080p below ~5 Mbps.
- **Wi-Fi:** remote streams are usually limited by internet upload, not
  Wi-Fi. At home, a 4K stream from a Wi-Fi server to a Wi-Fi TV crosses the
  air twice; heavy 4K remuxes may stutter. Fixes that need no router
  settings: an Ethernet cable to a spare router port, or powerline / MoCA
  adapters. Measure first (speed test on the server PC itself, at busy
  times, 5 GHz vs 2.4 GHz).
- Four independent drives, no redundancy: add **SMART drive-health
  warnings** to the dashboard and back up MartBox's own database/config.

### Server dashboard (Plex Dash-style, built up across Phases 1–4)

A **Dashboard** tab in the host app, admin-only, showing who's using the
server, what they're watching, and how the network and hardware are coping.
It doubles as the measuring tool for the Phase 2 speed work, so a first
version ships early.

**Build order**
- **v1 (with Phases 1–2):** Now Playing + Network panels. **Built**
  (`src/main/dashboard.ts`, Dashboard page in the host app): per-stream
  device, title, progress, playing/paused/buffering, direct/remux/transcode
  and why, live Mbps, stalls in the last 5 minutes, and Stop with a message;
  live upload graph (5 min) against an upload speed the admin enters;
  per-device Tailscale path, speed test, current rate and data today. Apps
  send a heartbeat every 10 s (iPhone build 15 / Apple TV build 18); older
  apps show up from their progress saves.
- **v2 (with Phase 4):** Hardware + transcoding panels.
- **v3 (after Phase 4):** History, stats, alerts, and the dashboard on
  mobile for admin devices.

**Now Playing** (one card per active stream, live)
- User + avatar, device (e.g. "Alex's iPhone"), title with poster, progress
  bar, paused/playing.
- **Direct play vs transcode** — and why (codec, bitrate cap, subtitle
  burn-in); source → output resolution/bitrate.
- Connection: LAN / Tailscale direct / DERP relay, latency, and
  the stream's current bandwidth.
- Buffering events in the last few minutes.
- Admin actions: stop a stream (with an optional message).

**Network**
- Live host upload/download graph; total remote bandwidth vs measured upload
  capacity ("3 streams using 18 of 25 Mbps").
- Per-friend: path type, latency, last throughput test, data used today.
- "Run speed test" button (host upload + per-friend throughput).

**Hardware**
- CPU, RAM, GPU/encoder utilisation; which encoder is in use (NVENC / QSV /
  AMF / VideoToolbox / software).
- Per-transcode speed (e.g. "1.8× realtime") and fps — below 1× means the
  viewer will buffer; flag it.
- Disk: free space on library and cache drives, read throughput, and
  **SMART health** per drive (warn before a drive fails).
- Temperatures where the OS exposes them.

**History & stats (v3)**
- Play history (who, what, when, how long, direct/transcode, path).
- Most-watched titles, per-user watch time, peak concurrent streams,
  bandwidth over 24 h / 7 d / 30 d.
- Library totals (movies, episodes, size).

**Alerts (v3)**
- Upload saturated, transcode below realtime, friend stuck on DERP relay,
  disk nearly full or SMART warning. Shown in the dashboard and as a
  desktop notification.

**How it works**
- **Sessions:** `mediaServer.ts` tracks a session per stream (user, device,
  item, transcode decision); clients send a playback heartbeat every ~10 s
  (position, state, buffering events).
- **Network:** per-peer bytes and path from tsnet status (sidecar JSON
  stream); host interface counters for totals.
- **Hardware:** the `systeminformation` npm package for CPU/RAM/disk/temps;
  `nvidia-smi` for NVIDIA GPUs; ffmpeg's `-progress` output for transcode
  speed/fps. Apple GPU and some Intel/AMD GPU stats may be limited without
  elevated permissions — show what's available, never ask for admin rights.
- **Live updates:** server-sent events from the main process to the renderer
  (and to admin devices over the tailnet in v3).
- **History:** a `play_history` table in SQLite, with a retention setting.

**Privacy & security**
- Admin-only: dashboard endpoints require an admin device key; never served
  to friend devices.
- No IP geolocation or IP addresses shown — device name and path type only.
- History retention configurable (default 90 days); "clear history" button.

## Security

Tailscale-only exposes nothing to the open internet: all traffic is
end-to-end encrypted WireGuard between tailnet devices. The risks are about
*who is in the tailnet* and *what they can reach*.

**Hard rules**
- Remote access is **off by default**; the host opts in.
- Friend devices can reach **only** the MartBox port on the host (access
  rules), never the host's other devices or services.
- Every request over the tailnet needs a device key (Phase 1), even though
  the tailnet is already private.
- Run a security review (`/security-review` + manual pass) on Phase 1 before
  release.

**What's exposed (and what isn't)**
- Not a VPN for anyone's general traffic, so no VPN-style DNS leaks.
- Friends on a direct path can see the host's public IP (city-level
  location) — inherent to peer-to-peer. Relayed paths hide it.
- Tailscale (the company) sees device metadata, not the video.

**Risks and mitigations**

| Risk | Mitigation |
|---|---|
| Friend devices reaching the host's other devices | Access rules: `tag:martbox-guest` → `tag:martbox-host` MartBox port only. **Verify the current tailnet policy now** — today the media server has no auth and relies on tailnet isolation |
| Leaked invite / auth key | One-time, tagged, 1-hour expiry, preauthorized; login code one-time with 24–48 h expiry |
| Bugs in our new auth code | Auth middleware on every route by default (allow-list, not deny-list); tests for every route unauthenticated; security review before release |
| Brute-forcing login codes | ≥ 60 bits of randomness, one-time, per-device rate limit + temporary lockout, constant-time comparison |
| Stolen device keys | Hashed at rest on host; Keychain / Keystore / `safeStorage` on clients; per-device revoke in Settings (also removes the tailnet device) |
| Tailscale API token theft (can add devices to the tailnet) | Stored encrypted (`safeStorage`); scoped to the minimum needed; never logged |
| Signed media URLs leaking (logs, history) | Short expiry, bound to user + item, never logged; strip query strings from request logs |
| Malicious media files exploiting ffmpeg | Keep jellyfin-ffmpeg current; run as the normal user, never elevated; only library files are processed |
| Outdated dependencies | `npm audit` / Dependabot in CI; signed app updates |
| Electron renderer compromise | Keep renderer sandbox + context isolation; no remote content in privileged windows |
| Secrets in the repo | `npm run check:sensitive` pre-commit hook and CI job |

**Not in scope:** hiding the host's IP from friends on a direct path, and
protecting against a compromised host machine.

## If the host is behind CGNAT

No router access is needed either way, so CGNAT matters much less on the
Tailscale path:
1. **Tailscale direct** — many ISPs' CGNAT still allows hole-punching, and
   IPv6 is used automatically when both sides have it.
2. **Tailscale DERP relay** when hole-punching fails, with quality
   auto-capped.

This applies to any MartBox host, not just ours.

Not recommended: **Tailscale Funnel** (always relayed, unpublished bandwidth
caps, heavy streaming may violate AUP) and **Cloudflare Tunnel** (ToS
restricts serving video outside their paid video products).

## Optional later: public HTTPS path

Not planned for our host (no router changes on a shared family router).
Kept as an option for other MartBox hosts who can open a port, modelled on
Plex:

- **How Plex does it:** server registers its addresses with plex.tv; opens
  its port via UPnP/NAT-PMP; gets a `*.plex.direct` cert; clients race LAN,
  public and relay URIs; Plex's paid relay is the last resort at a low
  bitrate. (Jellyfin/Emby: no relay; users forward ports and bring their own
  domain.)
- **MartBox version:** fixed public HTTPS port (e.g. 47824) via UPnP or manual
  forward; free DuckDNS hostname (random, e.g. `mb-7f3k9q.duckdns.org`);
  Let's Encrypt via ACME DNS-01; CGNAT detection (UPnP external IP vs public
  IP, WAN in the shared CGNAT range 100.64/10, RFC 6598) and IPv6;
  "Test from outside"; clients race LAN, public HTTPS and Tailscale.
- **Extra security if built:** only after Phase 1 passes review; off by
  default; public listener serves no admin routes; clients pin the server's
  public key from pairing (protects against DuckDNS token theft, where an
  attacker could repoint the hostname *and* get a valid cert); HTTPS on LAN
  too; UPnP maps only our port and removes it on quit; hostname will appear
  in Certificate Transparency logs and get scanned within minutes.

## Open questions
- Is any friend actually relayed, and how slow is it? (The Remote Access
  screen shows each friend's path; Users shows their speed test.)
- Host's upload bandwidth — sets the realistic per-friend bitrate and how many
  simultaneous remote streams are viable.
- Tailscale free Personal plan limits (third-party summaries, verify on
  tailscale.com): 6 users, unlimited user devices, ~50 tagged resources
  (caps friend devices, since they join tagged), limited ephemeral minutes.
- tsnet knob to disable automatic router port mapping, if the family wants
  it off.
- Tailscale for other hosts: each host needs their own Tailscale account +
  API key (free but clunky). A shared self-hosted coordination server was
  considered and dropped (no extra infrastructure).
