# Releasing MartBox

Installed copies of MartBox (Windows and macOS) update themselves from
GitHub Releases on this repo: they check on launch and every 6 hours,
download a new version in the background, and install it when MartBox
restarts (Settings → App Updates, or the tray menu's "Restart to install").

**User data is never touched by an update.** Libraries, profiles, watch
history, settings and the Tailscale identity live in the user-data folder
(`%APPDATA%\MartBox` on Windows, `~/Library/Application Support/MartBox` on
macOS), outside the app. The database is backed up to `backups/` as soon as
an update finishes downloading, and again right before it installs.
Schema changes go through the additive migrations in `src/main/db.ts`.

## Cutting a release

1. **Merge everything for the release into `main`.**
2. **Bump the version** on a branch, open a PR, merge it:
   ```sh
   npm version 0.2.0 --no-git-tag-version   # updates package.json + lock
   ```
   Bump `API_VERSION` in `src/shared/remoteAccess.ts` too if the host's HTTP
   API changed in a way older apps or hosts can't handle.
3. **Tag `main`** and push the tag:
   ```sh
   git switch main && git pull
   git tag v0.2.0 && git push origin v0.2.0
   ```
   CI (`.github/workflows/build-windows.yml`) builds the Windows installer
   and creates the GitHub release with `MartBox-Setup-0.2.0.exe`, its
   `.blockmap` and `latest.yml`. Windows installs start updating once it's
   published.
4. **Publish the Mac build**, on a Mac, once the release exists:
   ```sh
   npm run release:mac
   ```
   This builds both architectures and uploads the `.dmg`s, the `.zip`s
   (what the updater installs), their `.blockmap`s and `latest-mac.yml`.
   Until it runs, Mac installs simply see no update.
5. **Attach the Android app** (Fire TV and Android phones). The app lives in
   a separate private repository; its version matches the release. From
   that checkout, with its signing key in `keystore.properties`:
   ```sh
   ./gradlew assembleRelease
   cp app/build/outputs/apk/release/app-release.apk /tmp/MartBox-0.2.0.apk
   gh release upload v0.2.0 /tmp/MartBox-0.2.0.apk --repo matthewtheriault/martbox
   ```
   Keep the signing key safe and backed up: an update signed with a
   different key won't install over the existing app.
6. **Write release notes** on the GitHub release — they show up in
   Settings → App Updates while an update downloads.

Run `npm run check:sensitive` before tagging; CI also runs it.

## Signing and notarization (macOS)

macOS updates require the app to be code-signed — the Developer ID
certificate in the login keychain is picked up automatically. Notarization
removes the "can't be checked for malicious software" warning on first open;
it runs when these are set in the shell that runs `npm run release:mac`:

```sh
export APPLE_ID="<apple id email>"
export APPLE_APP_SPECIFIC_PASSWORD="<app-specific password from appleid.apple.com>"
export APPLE_TEAM_ID="<team id>"
```

Never commit these.

## Windows

The installer isn't code-signed, so Windows SmartScreen may warn on a fresh
install. In-app updates install without that prompt.

## Server and app versions

Client apps check the host's `GET /api/version` (`appVersion`,
`apiVersion`). If `apiVersion` differs from the app's `API_VERSION`, the app
shows which side needs updating instead of failing screen by screen. Hosts
older than 0.2 have no `/api/version` and are reported as "update the
server".

## First update-capable release

Copies older than the first release with in-app updates can't update
themselves — install that release manually once (over the old version; data
is kept). Every release after that arrives automatically.
