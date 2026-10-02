# Remote Access v2 — Plan (draft)

Status: **planning.**

## Why

Today, remote friends reach MartBox only over Tailscale (the tsnet sidecar in
`sidecar/main.go`, plus the gomobile `TsnetBridge` in the iOS/tvOS apps). It
works, but streaming is often slow. The likely cause: when two peers can't
punch a direct path, Tailscale falls back to its shared DERP relays, which are
throttled and not meant for sustained video. Setup is also fiddly for friends
(invite keys minted via a Tailscale API token), and on iOS the in-process
tunnel dies when the app is backgrounded.

Goal: **one invite code for friends, direct-speed streaming whenever the
host's network allows it**, with Tailscale kept as a fallback rather than the
only path.

## Model: how Plex does it

1. **Discovery** — the server registers its LAN and public addresses with
   plex.tv; clients get a list of candidate connection URIs per server.
2. **Port mapping** — the server opens its port on the router via UPnP /
   NAT-PMP (or the user forwards it manually); plex.tv checks reachability
   from the outside.
3. **HTTPS without a user domain** — Plex issues each server a cert for
   `*.<server-hash>.plex.direct`, where the hostname encodes the IP
   (`203-0-113-5.<hash>.plex.direct` → `203.0.113.5`).
4. **Connection racing** — clients try LAN, public, and relay URIs in
   parallel and use the first that answers.
5. **Relay as last resort** — when the server isn't reachable, Plex relays
   traffic through its own servers at a deliberately low bitrate cap.
6. **Bitrate fitting** — clients pick a remote-quality level; the server
   transcodes (hardware-accelerated if available) to match.

(Jellyfin/Emby, for comparison: no relay; the user does port forwarding and
brings their own domain + reverse proxy.)

## MartBox equivalent

| Plex piece | MartBox version |
|---|---|
| UPnP port mapping | Electron main process maps a fixed public port via UPnP/NAT-PMP (Node lib, e.g. `nat-upnp` / `nat-pmp`), with manual-forward fallback and a status readout in Settings |
| plex.tv reachability check | Settings → Remote Access "Test from outside" button (needs a tiny external checker — or reuse a public "is port open" API) |
| `plex.direct` certs | Free dynamic-DNS hostname (DuckDNS or similar) + automatic Let's Encrypt cert obtained/renewed by the app (ACME DNS-01 via the DDNS provider's API, so port 80 isn't needed) |
| plex.tv accounts / sharing | **No central accounts, no self sign-up.** Jellyfin/Emby-style server-local users: the host admin creates each user, which mints a one-time login code (extends `InviteCode` in `src/shared/remoteAccess.ts`) carrying the public URL + the code, alongside the existing Tailscale fields. Redeeming it gives the device its own revocable key |
| Connection racing | Clients race LAN URL, public HTTPS URL, and Tailscale; first healthy one wins; re-race on network change |
| Plex Relay | Existing Tailscale/tsnet path, demoted to fallback |
| Remote quality | Hardware transcoding + a few fixed bitrate ladders (see Phase 4) |

Login code (invite v2) sketch:

```ts
interface InviteCodeV2 {
  v: 2
  name: string            // server display name
  publicUrl?: string      // https://martbox-xyz.duckdns.org:47824
  loginCode: string       // one-time, expires after first use or 24–48 h
  tailscale?: { authKey: string; hostAddr: string; port: number } // fallback
}
```

The client redeems `loginCode` once (`POST /api/auth/redeem` with a device
name) and gets back a long-lived **device key** for that user, stored in the
Keychain (Apple) / Keystore (Android) / `safeStorage` (Electron). Every later
request sends the device key; the login code is useless after redemption.

## Recommended setup: the best free option

**Direct HTTPS first, Tailscale as backup, hardware transcoding everywhere.**
$0 for every host and friend; we run no servers.

**Host setup (one-time, ~5 minutes)**
1. Install MartBox, add media folders.
2. Settings → Remote Access: paste a free DuckDNS token. The app then:
   - opens the port via UPnP/NAT-PMP (manual-forward steps if the router
     refuses);
   - keeps `<name>.duckdns.org` pointed at the home IP;
   - gets and renews a Let's Encrypt cert (HTTPS);
   - detects CGNAT and IPv6 and says so in plain English ("Friends can
     reach you directly ✓");
   - tests reachability from outside.
3. Settings → Users → Add user → one-time login code / QR to send the friend.

**Friend setup:** install the app (iPhone, Apple TV, Android, Fire TV,
computer), enter or scan the code. Stays signed in with their own history.

**On play:** the client races LAN, direct HTTPS, IPv6 and Tailscale and uses
the first that answers, re-racing on network change. The host transcodes
with the GPU (NVIDIA / Intel / AMD / Apple) and drops quality to fit instead
of buffering.

**How each kind of host fares**

| Host's network | Friends connect via | Speed |
|---|---|---|
| Normal home internet (most people) | Direct HTTPS | Full — limited only by host upload |
| CGNAT, has IPv6 | Direct over IPv6 | Full (if the friend has IPv6 too) |
| CGNAT, no IPv6 | Tailscale direct (hole-punched) | Usually full |
| Strict NAT on both sides (rare) | Tailscale free DERP relays | Slow — auto-capped to 480p–720p |
| Wants to fix that last case | Optional guide: ask ISP for a public IP, or own free Oracle VM relay | Full |

**Why this design**
- **Free:** DuckDNS, Let's Encrypt, UPnP, Tailscale's free plan,
  jellyfin-ffmpeg.
- **Seamless:** friends never see Tailscale, ports or domains — just a code.
- **Faster than Tailscale-only:** most friends go direct; no iOS
  background tunnel drops on the main path.
- **No dead ends:** worst case is lower quality, never "can't connect".
- **Private:** no central accounts, nobody in the middle of the video.
- What Plex has that we don't: a fast paid relay for the strict-NAT case.

**Notes on Tailscale and transcoding**
- Tailscale *direct* paths are fast: WireGuard overhead is small, and even
  tsnet's userspace networking is normally well above home upload speeds.
  Only DERP-relayed paths are slow — Phase 0's diagnostics show which one
  friends get.
- Hardware transcoding happens on the host before the video goes over any
  path, so Phase 4 works identically over HTTPS or Tailscale (and matters
  most on relayed paths).

## Phases

### Phase 0 — Diagnose (cheap, do first)
- Surface in Settings whether each Tailscale peer is **direct or relayed**
  (tsnet `LocalClient().Status()` → peer `CurAddr` vs `Relay`; emit it from
  the sidecar's JSON status stream).
- Check whether the host is behind CGNAT: compare the router's WAN IP with
  the public IP (e.g. ifconfig.me). **If CGNAT, Phases 2–3 won't work as-is**
  — see "If the host is behind CGNAT" below.
- Quick win to try: give tsnet a fixed UDP port and forward it on the router
  (UDP 41641-style). Often converts relayed connections into direct ones with
  almost no code change.

### Phase 1 — Users & auth on the media server (prerequisite for anything public)
- The Express server in `src/main/mediaServer.ts` currently has **no auth**;
  it relies on loopback/tailnet isolation. Before exposing it:
  - **Server-local users** (Jellyfin/Emby model, no sign-up, no central
    service — free). Settings → Users: admin creates a user (name, avatar,
    optional limits: remote access on/off, max content rating), which
    generates a **one-time login code** + QR. The host's own user is the
    admin.
  - Redeeming a login code creates a **device key** for that user (SQLite,
    hashed at rest). Admin can see each user's devices, sign one out,
    disable a user, or issue a new login code (e.g. new phone).
  - **Per-user data:** watch progress, Continue Watching, watchlist (and
    later music history, game saves). Existing single-user rows migrate to
    the admin user.
  - Optional **profile PIN** for shared devices (e.g. a living-room Apple TV
    with a profile picker).
  - Middleware checking `Authorization: Bearer <device key>` on all `/api/*`, `/stream/*`,
    `/probe/*`, `/image`, `/live/*` routes.
  - Players can't always set headers on media requests (AVPlayer, `<video>`
    src), so also accept a short-lived signed query param on media URLs.
  - Rate-limit failed auth attempts.
- Keep the loopback listener (`127.0.0.1`, used by the local renderer)
  unauthenticated or auto-authenticated; add a **second listener** for the
  public port that always enforces auth.

### Phase 2 — Public HTTPS endpoint
- **Gate:** only after Phase 1 passes a security review (see Security).
  Off by default; random DDNS hostname.
- Fixed public port (e.g. 47824), served over HTTPS only.
- UPnP/NAT-PMP mapping with renewal; clear UI when it fails ("forward TCP
  47824 to this PC manually").
- DDNS: user pastes a DuckDNS token + subdomain once; app keeps the IP
  updated.
- Let's Encrypt via ACME DNS-01 (e.g. `acme-client` npm package), cert
  stored in `userData`, auto-renewed.
- **Network detection:** compare the UPnP-reported external IP with the real
  public IP, and flag a WAN address in the shared CGNAT range (100.64/10, RFC 6598) → CGNAT. Detect a
  global IPv6 address and serve on it too.
- Settings → Remote Access shows: mapping status, CGNAT/IPv6 result in plain
  English, public URL, cert expiry, "Test from outside" result.

### Phase 3 — Clients: login codes + connection racing
- Sign-in screen on every client: enter or scan a login code, redeem it,
  store the device key; profile picker if the device has several users.
- Desktop client mode (`src/main/remoteClient.ts`): accept v2 codes, race
  public URL vs Tailscale, send the device key on every request.
- iOS/tvOS clients (separate repos): `ServerConfig` /
  `APIClient` learn the public URL + device key; only start `TsnetClient` if the
  public URL fails. This should also fix the background/foreground tunnel
  drops on iOS for most users.
- Keep v1 invite codes working during transition.

### Phase 4 — Hardware transcoding + bitrate ladder
- Swap `ffmpeg-static` (likely built without GPU encoders) for
  **jellyfin-ffmpeg** portable builds (NVENC / QSV / AMF / VAAPI /
  VideoToolbox).
- At startup, probe candidate encoders with a 1-second test encode; pick the
  first that works, fall back to `libx264` (current behavior in
  `mediaServer.ts`).
- Add `-hwaccel auto` decoding.
- Offer a few fixed remote-quality levels (e.g. Original / 1080p 8 Mbps /
  720p 3 Mbps / 480p 1.5 Mbps); default remote clients to a level that fits
  the host's upload bandwidth. Longer term: move VOD transcodes to HLS with
  multiple renditions so players can adapt automatically.

## Security

Public HTTPS puts a server on the open internet, which Tailscale-only never
did. Goal: on par with Jellyfin/Emby done properly.

**Hard rules**
- **Phase 2 never ships before Phase 1 is complete and reviewed.** Run a
  full security review (`/security-review` + manual pass) before the public
  listener is enabled in any release.
- Remote access is **off by default**; the host opts in.
- The public listener serves only authenticated media/API routes — no admin
  or settings endpoints, ever.

**What's exposed (and what isn't)**
- Not a VPN, so no VPN-style DNS leaks: MartBox never routes anyone's
  general traffic.
- The host's home IP is public via the DDNS hostname (city-level location).
  Friends see it anyway on direct paths.
- Every Let's Encrypt cert is published in Certificate Transparency logs;
  bots scan new hostnames within minutes. Assume the server will be found.
  Use a **random hostname** (e.g. `mb-7f3k9q.duckdns.org`), never one with
  the host's name.
- Friends' DNS resolvers/ISPs see which hostname they connect to and how
  much data moves — not what's being watched (TLS).

**Risks and mitigations**

| Risk | Mitigation |
|---|---|
| Bugs in our new auth code (biggest risk) | Auth middleware on every route by default (allow-list, not deny-list); tests for every route unauthenticated; security review before release |
| Brute-forcing login codes | ≥ 60 bits of randomness, one-time, 24–48 h expiry, per-IP rate limit + temporary lockout, constant-time comparison |
| Stolen device keys | Hashed at rest on host; Keychain / Keystore / `safeStorage` on clients; HTTPS only; per-device revoke in Settings |
| Signed media URLs leaking (logs, history) | Short expiry, bound to user + item, never logged; strip query strings from request logs |
| DuckDNS token theft — attacker repoints the hostname *and* gets a valid cert via DNS-01 | Store the token encrypted (`safeStorage`); clients **pin the server's public key** received at pairing and reject a different server even with a valid cert; key rotation pushes the new pin over the old trusted connection |
| Plain HTTP on the LAN path (shared Wi-Fi, dorms) | HTTPS on LAN too, verified against the pinned key |
| Malicious media files exploiting ffmpeg | Keep jellyfin-ffmpeg current; run as the normal user, never elevated; only library files are processed |
| UPnP | Map only our one port; remove the mapping on quit; manual forward stays an option for hosts who disable UPnP |
| Tailscale friends reaching the host's other devices | Tailscale ACLs: friend devices (tagged) may reach **only** the MartBox port on the host node; auth keys one-time, short-lived, preauthorized-tagged. **Verify the current tailnet ACLs now** — today the media server has no auth and relies on tailnet isolation |
| Outdated dependencies | `npm audit` / Dependabot in CI; signed app updates |
| Electron renderer compromise | Keep renderer sandbox + context isolation; no remote content in privileged windows |
| Secrets in the repo | `npm run check:sensitive` pre-commit hook and CI job |

**Not in scope:** hiding the host's IP from friends who connect directly
(use Tailscale-only mode if that matters), and protecting against a
compromised host machine.

## If the host is behind CGNAT

Applies to any MartBox host, not just ours, so it must be automatic. Port
forwarding can't work, but the client's connection race falls through
these on its own:
1. **IPv6** direct, if both sides have it (no forwarding needed).
2. **Tailscale direct** — many ISPs' CGNAT still allows hole-punching.
3. **Tailscale DERP relay**, with remote quality auto-capped to 480p–720p.

Optional, for technical hosts (a guided page in Settings):
- Ask the ISP for a public IPv4 (often free).
- A free Oracle Always Free VM as their own relay (WireGuard/`frp` tunnel,
  or a Tailscale peer relay — check free-plan limits). No paid VPS.

Not recommended: **Tailscale Funnel** (always relayed, unpublished bandwidth
caps, heavy streaming may violate AUP) and **Cloudflare Tunnel** (ToS
restricts serving video outside their paid video products).

## Open questions
- Is the host behind CGNAT? (Phase 0 answers this.)
- Host's upload bandwidth — sets the realistic per-friend bitrate and how many
  simultaneous remote streams are viable.
- DuckDNS vs. buying a domain (a domain makes the URL nicer and allows a
  wildcard cert).
- Whether to drop the gomobile `TsnetBridge` from iOS/tvOS entirely once the
  public path is proven, to simplify those builds.
- Tailscale for other hosts: each host needs their own Tailscale account +
  API key (free but clunky). Alternative: one shared Headscale coordination
  server on a free Oracle VM (low bandwidth, seamless, but we'd operate a
  service). Defer until other people run servers.
- Verify Tailscale free Personal plan limits (users/devices) and whether
  peer relays are available on it.
