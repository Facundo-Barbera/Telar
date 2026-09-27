# Desktop bundle id: `com.telar.desktop` → `io.github.novarix.telar`

Design for the desktop half of #1042. No shipped behaviour changes with this doc.

| Build | Today | After |
|---|---|---|
| Shipping (beta, nightly) | `com.telar.desktop` | `io.github.novarix.telar` |
| Dev package (`--dev`) | `com.telar.desktop.dev` | `io.github.novarix.telar.dev` |
| Computer-use helper | `com.telar.desktop.computer-use` | **unchanged** (§2.6) |

Things marked **UNVERIFIED** are what we expect from Apple/Electron behaviour but have
not measured on this app. Each one has a by-hand check in §5.

## 1. How an update gets installed today

- **The updater is electron-updater** (`apps/desktop/main.js:21`, configured in
  `configureAutoUpdater`, `main.js:3186`). It uses the generic provider
  (`apps/desktop/package.json:173-176`). The URL and the `X-Telar-Update-Key` header are
  baked in at build time (`scripts/build-desktop.sh:199-204`, `main.js:2455-2461`,
  `main.js:3195`).
- **Feeds:** one R2 bucket, served read-only by `workers/updates-proxy`, which checks the
  key (`workers/updates-proxy/src/index.js:190`) and uses the URL path as the object key
  (`:195-196`). `build-desktop.sh` uploads every artifact to the **bucket root**:
  `upload()` uses `basename` (`scripts/build-desktop.sh:350-355`), assets first and feeds
  last (`:356-367`). The feeds are `beta-mac.yml` and `nightly-mac.yml`. The client
  picks one with `autoUpdater.channel` (`main.js:3174-3179`), and the choice is
  persisted in `userData/update-prefs.json` (`main.js:2474-2479`).
- **The swap is Squirrel.Mac (ShipIt).** On macOS, electron-updater's `MacUpdater` gives
  the zip to Electron's native `autoUpdater`, which is Squirrel.Mac. The workflows say
  so: `nightly-desktop.yml:142-143` ("Squirrel verifies the signature, not the
  notarization") and `main.js:3269-3306` (`quitAndInstall`). Squirrel.Mac accepts an
  update only if its code signature satisfies the **running app's designated
  requirement** (DR). For a Developer ID app the DR is roughly
  `identifier "com.telar.desktop" and anchor apple generic and … certificate leaf[subject.OU] = <TEAM>`.
  A new-id build fails the `identifier` clause, so **no feed can take a user across the
  id change through Squirrel**. (This is from Squirrel.Mac's `SQRLCodeSignature` source.
  electron-updater is not vendored in this worktree, so it was not re-read here.)
- **The "ditto swap helper"** (`apps/desktop/dev-update-core.js:159-209`, run for real in
  `dev-update.test.js:158` on the macOS job `verify.yml:335`) is the **dev-only**
  self-update for Telar Dev. It is not part of shipping updates. It is still the right
  starting point for the hand-off (§3): it stages beside the target, waits for the
  parent pid, renames the current app to last-good, renames the candidate in, and
  relaunches, restoring last-good if anything fails.
- **Betas are notarized and nightlies are not** (`release-desktop.yml:117-143`,
  `nightly-desktop.yml:131-150`). Nightlies only work because the update channel does
  not set the quarantine bit.

## 2. Hazards and what happens to each

### 2.1 Updates (blocking)
Squirrel rejects the new DR (§1). **Resolution:** a last old-id release carries a
custom hand-off installer that does not go through Squirrel (§3), and the feeds are
split (§3.5).

### 2.2 userData: kept
Electron builds `app.getPath("userData")` as `appData/<app.getName()>`, and
`app.getName()` prefers `productName` (`package.json:5-6` explains this). The name is
`"Telar"`, so the path is `~/Library/Application Support/Telar` (`main.js:384`). The
bundle id is not part of it. A packaged, non-dev, non-E2E, non-smoke build never calls
`app.setName`/`app.setPath`. The only calls are for E2E (`main.js:89-90`), smoke
(`:91-95`), the dev package (`:96-100`, explicit `appData/Telar Dev`) and an
unpackaged shell (`:101-126`). With `productName` unchanged, all of these carry over:
the engine store (`TELAR_HOME` = userData unless overridden, `main.js:410-419`),
Chromium partitions, `update-prefs.json`, `ui-prefs.json`, `keybindings.json`,
`server-port.json`, browser profiles and site permissions (`main.js:1267-1290`), and the
relay v2 credential (the phone hands `{handle, keyId, sendKey}` to the web tier, and
nothing is in the Keychain: `apps/web/lib/mobile/relay-v2.ts:7-10`).
**Guard:** a unit test pins `productName === "Telar"` next to the new `appId`, so a later
rename can't silently move the data. `packaging.test.js:232-233` already pins it; the
test stays.

The single-instance lock is also scoped through userData (`main.js:85-88`,
`main.js:3774`). Old and new builds therefore **cannot run at the same time**, which
suits an in-place swap (§3.3). It also means a rollback must make sure the new app has
exited before relaunching the old one.

### 2.3 Keychain
- **"Telar Safe Storage"** (service `Telar Safe Storage`, account `Telar`). Telar never
  calls `safeStorage` (no match in `apps/desktop`). Chromium's `os_crypt` creates this
  item itself to encrypt cookies and passwords in every persistent partition
  (`persist:telar-project-*`, `persist:telar-integrated-browser`,
  `browser-profiles.js:15,53`). The name comes from the app name, so the new app looks
  up **the same item**. The item's ACL, however, trusts the old app's DR. **Expected:**
  on first launch the new app raises one "Telar wants to use … 'Telar Safe Storage'"
  prompt, and *Always Allow* keeps every site login. **If the user denies it**, stored
  cookies can't be decrypted and every browser profile is signed out. **UNVERIFIED:**
  whether Electron 43 prompts or silently creates a new key. This is the **top data
  risk**, and the hand-off UI warns about it (§3.1).
- **Relay entry `com.telar.push-relay`: moot.** The shell's writer was removed in
  `9c1b4d38` ("drop the relay credential writer from the shell"), and relay v2 needs no
  Keychain item (`relay-v2.ts:9`). Any old item is orphaned and harmless. It was
  written through `/usr/bin/security`, so its ACL was never tied to Telar's DR anyway
  (`cac72104:apps/desktop/push-relay.js`). The issue text still lists it; this doc
  supersedes that line.
- **Not Telar's items:** Claude credentials (per-config-dir items owned by the `claude`
  CLI, `apps/engine/src/provider-instances.ts:55`). The accessing binary doesn't change,
  so they are unaffected. The 1Password `op` desktop integration authorizes the calling
  app. **UNVERIFIED:** expect one "allow Telar" prompt from 1Password
  (`apps/desktop/vault-metadata.js`).

### 2.4 TCC grants: re-prompted, cannot be carried over
TCC keys grants on bundle id plus code requirement, and `TCC.db` is SIP-protected. Only
MDM/PPPC can pre-grant, so the new app starts with no grants. Grants the **main app**
holds:

| Service | Where it is requested | After |
|---|---|---|
| Automation (Apple Events → Codex Computer Use) | `NSAppleEventsUsageDescription` `package.json:166`; entitlement `build/entitlements.mac.plist:24` | re-prompt on first computer-use call |
| Camera / Microphone | `site-permissions.js:442,452`; `package.json:168,170`; entitlements `:36,38` | re-prompt on first site request |
| Screen Recording (browser screen share) | `desktopCapturer` `site-permissions.js:465-471` | re-prompt on first share |
| Files & Folders (Desktop/Documents/Downloads, removable/network volumes) | not requested explicitly; triggered when the engine touches project dirs | re-prompt on access (**UNVERIFIED** which ones a given user has) |
| Full Disk Access, if the user added it by hand | n/a | lost silently; the user must re-add it |
| Accessibility | not requested by the main app (the helper holds it, §2.6) | n/a |

The old `com.telar.desktop` rows stay in System Settings (for example two "Telar"
entries under Automation). The new app can offer a one-time cleanup,
`tccutil reset All com.telar.desktop`. **UNVERIFIED:** whether this works without admin
for user-scope services.

### 2.5 Notifications, defaults, login items, URL schemes
- **Notifications** (`desktop-notifications.js:140`, Electron `Notification`):
  authorization and style (banner/alert, sounds, Focus) are stored per bundle id. The
  new app asks again on its first banner and lands on system defaults. The old "Telar"
  row stays in Notification settings.
- **NSUserDefaults** (`~/Library/Preferences/com.telar.desktop.plist`): Telar writes
  none. There are no `systemPreferences.setUserDefault` calls; all prefs are JSON in
  userData (§2.2). Only AppKit/Chromium state lives there (window restoration, open
  panel dirs). It is lost, harmlessly. `~/Library/Saved Application State/com.telar.desktop.savedState`,
  `~/Library/Caches/com.telar.desktop.ShipIt` and `~/Library/HTTPStorages/com.telar.desktop`
  are orphaned. The new app can delete the old-id ones once it confirms it booted.
- **Login items:** none. There is no `setLoginItemSettings`, `SMAppService` or LaunchAgent in
  `apps/desktop` or `scripts`.
- **URL schemes:** none. There is no `protocols` in `build`, no `setAsDefaultProtocolClient`
  and no `open-url` handler.
- **Dock pin / Spotlight:** the swap keeps the same path (`/Applications/Telar.app`).
  The Dock stores both URL and bundle id. **UNVERIFIED:** whether a pin survives an id
  change at the same path or turns into a "?" that must be re-pinned.

### 2.6 Computer-use helper: **keep `com.telar.desktop.computer-use`**
- The helper has its own identity specifically so its Accessibility and Screen Recording
  grants are its own and survive Telar updates (`apps/engine/src/computer-use.ts:97-107`).
  `computer-use-helper.json:2` says "bundleId must never change, or every user's macOS
  grants are orphaned".
- Its DR is its own (`identifier "com.telar.desktop.computer-use"` + team), signed
  separately by `scripts/computer-use-helper.mjs:67` and excluded from electron-builder
  signing (`package.json:159-161`, rationale `:10`). The parent's id change does not alter it, so
  **its grants survive the hand-off**. These are the two grants that are hardest for a
  user to re-grant: System Settings panes, not a dialog.
- iPhone Mirroring matches on the main app's id (#1042). The helper's id doesn't collide
  with `io.github.novarix.telar`, so renaming it gets nothing.
- Its state dirs (`~/Library/Caches|Application Support/com.telar.desktop.computer-use`,
  `computer-use.ts:142-143`) also stay.
- Cost: a cosmetic `com.telar.*` leftover. If it is ever renamed, that is a separate
  release with its own "grants reset" note. It is not part of this migration.
- Whether the helper's TCC attribution changes when its *responsible parent* changes is
  **UNVERIFIED**. It is launched through LaunchServices with responsibility disclaimed
  (`computer-use.ts:163-176`), so it should be independent.

### 2.7 Dev variant: `com.telar.desktop.dev` → `io.github.novarix.telar.dev`
The dev package is unsigned, has no updater (`main.js:2742-2744`), and uses an explicit
userData of `appData/Telar Dev` (`main.js:100`). The change is just the id. Its TCC
grants reset, and there is no hand-off. **One trap:** an installed old Telar Dev running
"Update from local checkout" validates the candidate with **its own** copy of
`DEV_BUNDLE_ID` (`dev-update-core.js:21,145`). It rejects the new-id candidate
("Info.plist does not carry com.telar.desktop.dev"), which is safe. Each developer
reinstalls once with `bun run package:dev` and copies the app by hand. Note this in
`TESTING.md`.

### 2.8 Every place the id is written down
- `apps/desktop/package.json:52` `build.appId`
- `scripts/package-desktop.sh:118,135,186-187` (dev id override + post-build check)
- `apps/desktop/dev-update-core.js:21` `DEV_BUNDLE_ID`
- `apps/desktop/packaging.test.js:231,249`
- `apps/desktop/shell-array-expansion.test.js:188,196`
- `apps/desktop/TESTING.md:73`
- Unchanged: `computer-use-helper.json:8`, `apps/engine/src/computer-use.ts:107`,
  `computer-use-helper.test.js:32`, `apps/engine/test/computer-use.test.ts:101-102,206-207`,
  `scripts/bump-computer-use-helper.test.mjs:124`, `after-pack.js:103-104` (reads the
  helper's id, not the app's)

## 3. The safe hand-off

Two releases per channel:

- **H** (hand-off): the last `com.telar.desktop` build.
- **N**: the first `io.github.novarix.telar` build, with a higher version than H.

### 3.1 H: what it does
H is a normal old-id build and reaches every old install through Squirrel. It adds one
module, `desktop-handoff.js`, with a pure core (like `dev-update-core.js`) and a thin
Electron wiring. Squirrel is never used for N.

1. **Discover.** Fetch `handoff-mac.json` from the **new** feed prefix (§3.5) with the
   same key header. It contains `{version, channel, zip, sha512, size, bundleId, teamId}`.
   H only accepts a manifest whose `bundleId` is exactly `io.github.novarix.telar`.
2. **Explain, then ask.** Show a one-time window. It says Telar is moving to a new app
   identity, that data and settings are kept, and that macOS will ask again for:
   Keychain ("Telar Safe Storage": choose *Always Allow* or browser sign-ins are lost),
   notifications, Automation, camera/mic/screen share. The computer-use helper's
   permissions are kept. Buttons: *Install now* / *Later*. *Later* asks again on the
   next launch. There is no silent install-on-quit for H: `autoInstallOnAppQuit` is
   ignored for the hand-off because the Keychain prompt needs a person present.
3. **Download** to `userData/handoff/` and check the size and `sha512` against the
   manifest.
4. **Unpack** with `ditto -x -k` into `userData/handoff/staged/`. Neither `ditto` nor a
   Node/Electron `net` download adds `com.apple.quarantine`. **UNVERIFIED** on macOS 15+
   with `com.apple.provenance`. Because of that, N is **notarized on both channels**,
   nightly included (§4), so a Gatekeeper assessment passes whatever it finds.
5. **Verify the signature against a requirement H builds itself**, not against its own
   DR:
   ```
   codesign --verify --deep --strict "$STAGED/Telar.app"
   codesign --verify -R='identifier "io.github.novarix.telar" and anchor apple generic
     and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13]
     and certificate leaf[subject.OU] = "<TEAM>"' "$STAGED/Telar.app"
   spctl --assess --type execute "$STAGED/Telar.app"
   ```
   `<TEAM>` is read from **H's own running signature** (`codesign -dv` on the running
   bundle → `TeamIdentifier`), not taken from the manifest. A compromised feed
   therefore can't substitute a different team. The manifest's `teamId` is only
   cross-checked. The expected value is `MM74W7WGAM`, the iOS team in `verify.yml:800`.
   **UNVERIFIED** that the Developer ID cert in `MACOS_CERT_P12_BASE64` belongs to the
   same team; read it off a shipped build before writing H. Also check that
   `Contents/Helpers/Computer Use for Telar.app` inside N still answers to
   `com.telar.desktop.computer-use` (same check as `after-pack.js:103-104`).
6. **Swap** with a detached helper script generated by the core. It extends
   `dev-update-core.js:175-209`:
   - `TARGET` = the running bundle (`runningBundlePath(process.execPath)`, usually
     `/Applications/Telar.app`). The app is replaced **in place at the same path**,
     not installed side by side. The Dock, Spotlight, the helper path and people's
     habits all point at that path, and the single-instance lock (§2.2) means two
     copies can't run together anyway.
   - **Refuse and fall back to manual** (a window with the DMG link and steps) if the
     app is translocated (`/AppTranslocation/` in the path), if `dirname(TARGET)` isn't
     writable by the user, or if `TARGET` is on a read-only volume.
   - Order: `ditto` the staged app to `$(dirname TARGET)/.Telar.handoff.app` (same
     volume, so the later `mv` is atomic) → wait for H's pid → `mv TARGET
     userData/handoff/last-good.app` (with a `ditto` fallback across volumes) → `mv`
     incoming → `TARGET` → `open TARGET`.
7. **Boot confirmation.** The first N boot that gets past the engine-worker check (the
   same bar `build-desktop.sh` smoke uses, `scripts/build-desktop.sh:325-334`) writes
   `userData/handoff/confirmed.json` with its version and bundle id.

### 3.2 Rollback
- The helper waits up to 180 s for `confirmed.json`. If it doesn't appear, the helper
  (a) finds the N process by its exact executable path under `TARGET` and sends SIGTERM
  to **that pid only**, then waits for it to exit so the userData lock is free (§2.2);
  (b) moves N aside to `userData/handoff/failed.app`; (c) restores `last-good.app` to
  `TARGET`; (d) launches it; (e) writes `handoff/failed.json`.
- When H starts and finds `failed.json`, it stops offering the hand-off for that
  version, shows "the new version could not start; you are still on the old one", and
  offers a diagnostics export (`main.js:2929`). A newer `handoff-mac.json` version
  clears the block.
- N deletes `last-good.app` only on its **second** successful launch, or after 7 days,
  whichever comes later. Until then, a user can roll back by hand by dragging it back.
- Data needs no rollback. N and H share userData, so N must not run a migration H can't
  read. N does no store-format migration in the same release.

### 3.3 What N does on its first launch
- It runs `adoptLegacyUpdatePrefs`-style logic only if needed. It isn't needed here:
  `update-prefs.json` is already in the same userData, so the channel is kept (§2.2).
- It writes `confirmed.json`, and once confirmed it deletes the old-id caches from §2.5
  (`com.telar.desktop.ShipIt`, the saved state, HTTPStorages). It never deletes
  `com.telar.desktop.computer-use` state.
- It offers the optional `tccutil reset … com.telar.desktop` cleanup (§2.4).

### 3.4 Where the Keychain, TCC and data end up

| Item | Mechanism |
|---|---|
| userData, engine store, prefs, profiles | carried over automatically (same path) |
| Telar Safe Storage | same item; one ACL prompt; user must *Always Allow* |
| TCC (main app) | re-prompted on first use; explained up front by H |
| TCC (computer-use helper) | kept (same id and team) |
| Notification settings | re-prompted; style resets |
| Old-id leftovers | cleaned by N after confirmation |

### 3.5 Splitting the feed
- **New builds publish under a prefix.** Add `--feed-prefix` to `build-desktop.sh`.
  `upload()` then writes `s3://$R2_BUCKET/$PREFIX/<basename>`, and `publish.url` becomes
  `$UPDATE_PROXY_URL/$PREFIX`. The prefix is `io.github.novarix.telar`, so N's feed is
  `…/io.github.novarix.telar/{beta,nightly}-mac.yml`. The proxy already treats the whole
  path as the key (`workers/updates-proxy/src/index.js:195-196`), so the worker needs no
  change and the key stays the same.
- **The old feeds at the bucket root point at H forever.** After H publishes, nothing
  may write root `beta-mac.yml` or `nightly-mac.yml` again. Enforce it: once the prefix
  flag lands, `build-desktop.sh` refuses `--publish-r2` without `--feed-prefix`. An old
  install on any version gets H through Squirrel, and H hands off. H is the *only* thing
  the root feeds will ever offer.
- **`handoff-mac.json`** lives in the new prefix, one per channel
  (`handoff-beta-mac.json`, `handoff-nightly-mac.json`). CI writes it next to N's feed.
  H reads the one for its persisted channel.
- Keep H's root artifacts in R2 indefinitely. They cost almost nothing, and deleting
  them would strand anyone who opens an old install a year from now.

## 4. Changes by PR (after the experiment in #1042 step 1)
1. `feat(desktop): publish the update feed under a prefix`: add `--feed-prefix` to
   `build-desktop.sh`, add tests, leave the workflows unchanged.
2. `feat(desktop): hand the app off to its new identity`: add `desktop-handoff.js`
   (core and wiring) plus tests. It is gated so it acts only if `handoff-*-mac.json`
   exists. **This is H.**
3. `feat(desktop): build the app as io.github.novarix.telar`: `appId`, the dev id,
   `DEV_BUNDLE_ID`, `package-desktop.sh`, the tests from §2.8, `TESTING.md`, first-launch
   cleanup (§3.3), and the workflows passing `--feed-prefix`, plus notarization for the
   nightly (restore the three `APPLE_API_*` vars in `nightly-desktop.yml`). **This is N.**

## 5. Test plan

**In CI** (ubuntu unit job, plus the macOS job `verify.yml:335` for anything that needs
`ditto`/`codesign`):
- Pure core: parse and validate the manifest (wrong `bundleId` or bad sha512 is
  refused), build the requirement string from a given team, detect translocation and a
  non-writable target, and the state machine for `confirmed.json` / `failed.json`.
- The swap/rollback script runs for real against fake bundles, the same pattern as
  `dev-update.test.js:158`. Cover success; `mv` failure restoring last-good; confirm
  timeout, where a stub "N" that never confirms is terminated **by its own pid**,
  last-good is restored, and `failed.json` is written.
- Signature gate: an ad-hoc-signed fake with the wrong identifier fails
  `codesign -R` (the macOS job can ad-hoc sign). The real team check cannot be run in
  CI without the Developer ID cert, so it is by hand.
- Feed split: `build-desktop.sh` with `--feed-prefix` computes the prefixed keys and
  `publish.url` (test the argument building the way `shell-array-expansion.test.js`
  does), and `--publish-r2` without a prefix is refused.
- Pins: `appId === "io.github.novarix.telar"`, `productName === "Telar"`, the dev id,
  and the helper id is unchanged.

**By hand** (spare Mac user account or VM; never the daily install):
1. Install the current beta. Grant camera, Automation and helper Accessibility/Screen
   Recording. Sign into a site in a browser profile. Set the channel to nightly.
2. Publish H and N to a **staging bucket prefix** (never the production root), point a
   build at it, and run the hand-off.
3. Check: same userData (channel still nightly, sessions present); the Keychain prompt
   appears once, and after *Always Allow* the site is still signed in (settles §2.3
   UNVERIFIED); deny it on a second run and record what happens; helper grants still
   present; Automation/camera re-prompt; notification re-prompt; Dock pin (§2.5); no
   Gatekeeper dialog (§3.1 step 4).
4. Rollback: install an N that exits before confirming. Expect H back at the same path
   within about 3 minutes with the failure notice.
5. Refusals: a translocated H (run from the DMG) and a non-writable `/Applications`
   should both show manual instructions.
6. iPhone Mirroring: with N installed, confirm the iPhone app shows "Installed on this
   Mac" (the point of #1042; its step 1 is the ad-hoc experiment).

## 6. Rollout checklist
1. [ ] #1042 step 1 experiment confirms the premise (no shipped ids change).
2. [ ] Read the Developer ID team off a shipped `Telar.app` (`codesign -dv`); record it here.
3. [ ] Merge PR 1 (feed prefix). No behaviour change yet.
4. [ ] Merge PR 2 (H). Cut **H-beta** and **H-nightly** to the root feeds as normal.
5. [ ] Merge PR 3 (N) on a branch, build and notarize N into the new prefix **without**
       a `handoff-*-mac.json` yet. Install it by hand on a test account.
6. [ ] Run the §5 by-hand plan against a staging prefix. Settle every UNVERIFIED line,
       then update this doc.
7. [ ] Publish `handoff-nightly-mac.json`. Hand off the nightly users (the author's
       machines) first and watch `update.log` and `failed.json` for a few days.
8. [ ] Publish `handoff-beta-mac.json`.
9. [ ] From now on, `--publish-r2` requires `--feed-prefix`. Root feeds are frozen at H.
10. [ ] Update README/TESTING (dev reinstall note, §2.7) and the GitHub Release notes
        (what re-prompts, and to choose *Always Allow*).
11. [ ] Leave H's root artifacts in R2 and never delete them.

## 7. Top risks
1. **Browser sign-ins lost** if the Safe Storage prompt is denied or doesn't appear
   (§2.3). Mitigation: explain it up front, test by hand, and keep last-good so the user
   can go back.
2. **A hand-off that half-completes** leaves no working app. Mitigation: the rename
   order, last-good kept, rollback on confirm timeout, and swap tests run for real in
   CI.
3. **Someone publishes to the root feeds after H**, so old installs skip H or get
   something else. Mitigation: `build-desktop.sh` refuses it.
4. **Gatekeeper blocks N** after a non-Squirrel install (provenance/quarantine).
   Mitigation: notarize N on both channels and run `spctl` before the swap.
5. **TCC friction.** Every main-app grant re-prompts. The helper's grants are kept by
   design (§2.6).
