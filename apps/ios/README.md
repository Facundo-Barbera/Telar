# Telar Mobile

A native SwiftUI iOS client for the Telar cockpit, sessions-first: inbox,
live transcripts, replies, approvals. It speaks the cockpit's `/api/**`
surface — never the engine directly, whose loopback bind and per-boot token
are deliberate.

## How it connects

The Mac runs the cockpit bound to its tailnet address:

```
TELAR_WEB_HOST=<tailnet IP> bun scripts/dev.mjs     # or the desktop app equivalent
```

The phone (with Tailscale installed, same tailnet) points at
`http://<tailnet IP>:3000` — or at the `https://*.ts.net` endpoint when the
stack runs with `TELAR_TAILSCALE_SERVE=1` (requires HTTPS certificates
enabled for the tailnet at login.tailscale.com/admin/dns).

## Pairing

When the cockpit has "Require pairing" on (Settings → Remote access), every
`/api` call needs a device token. Pairing from the phone: scan the QR off
the Mac's Remote access panel (real hardware), or copy the link under the QR
and paste it into the Connect screen (simulator). The exchanged device token
lives in the Keychain; the base URL stays in UserDefaults — an address, not
a secret. A revoked or reset cockpit surfaces as a "requires pairing" state,
fixed by a fresh code. Lockout recovery on the Mac:
`rm <TELAR_HOME>/remote/remote.json`.

The ATS exception in `Config/Info.plist` stays until the ts.net HTTPS
endpoint is the only supported address — ATS cannot whitelist a bare 100.x
IP via NSExceptionDomains.

## Building

No Bun involvement — `apps/ios` has no `package.json` on purpose, so the
workspace tooling never sees it. Xcode 26+ required; `xcode-select` is not:

```
export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
xcodebuild -project apps/ios/TelarMobile.xcodeproj -scheme TelarMobile \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath apps/ios/DerivedData CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/ios/TelarMobile.xcodeproj -scheme TelarMobile \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath apps/ios/DerivedData test
```

The project uses Xcode's file-system-synchronized groups: dropping a
`.swift` file into `TelarMobile/` or `TelarMobileTests/` adds it to the
build with no project-file edit.

## Installing on a phone

Headless, via `apps/ios/phone.sh` (no Xcode GUI) — installs "Telar Dev"
(`com.telar.mobile.dev`, Debug, amber icon), the cable-fed build that lives
beside the TestFlight nightly. Two bundle ids make them UNRELATED APPS to
iOS; each keeps its own pairing (Keychain is per-app), so pair each once
and it survives reinstalls of that flavor.

A paid developer account's profile lasts a year; no TestFlight required.
The simulator needs no signing at all and shares the Mac's network stack,
so it reaches the cockpit on either the tailnet IP or localhost.

## Nightlies over TestFlight

Cutting a nightly is pushing a tag:

```
git tag ios-nightly-YYYYMMDD && git push origin ios-nightly-YYYYMMDD
```

The Actions workflow (.github/workflows/nightly-ios.yml) runs
`apps/ios/nightly.sh` on a macOS runner: archive, export (the re-sign to
Apple Distribution — `destination: upload` ships a dev-signed binary Apple
refuses), altool upload. The phone then updates itself through the
TestFlight app (internal testing: no review, live minutes after
processing, builds expire after 90 days).

Credentials are the repo secrets `APPLE_API_KEY_P8_BASE64` /
`APPLE_API_KEY_ID` / `APPLE_API_ISSUER` — an ADMIN App Store Connect API
key (cloud signing refuses less), shared with desktop notarization. The
nightly does not ship from a dev Mac: a beta-Xcode build is refused by App
Store Connect, and this Mac only has the beta. `nightly.sh --no-upload`
still archives locally for debugging.

## Mobile experience (iPhone and iPad)

The app is universal (iOS/iPadOS 18+). Its sidebar follows the desktop's
attention → pins → project groups → Snoozed / Settled structure, with saved
text drafts first. Search includes every session shelf. Mac and project filters
narrow the list; a session retains its host-qualified identity throughout
navigation, notification taps, and local Live Activity links.

Project ordering reads and writes each Mac's `/api/sidebar-layout` document.
Drag a project onto another project on the same Mac, or use its context menu's
Move up/down actions. Hidden project keys are preserved. Cross-Mac global
ordering is not synchronized: host IDs belong to each cockpit's host book, so
one cockpit's remote-host keys cannot be reused as this phone's UUIDs.

On iPad the sidebar and conversation share a split view; Changes opens an
inspector on a regular-width display. Compact windows and iPhone use a
navigation stack for changes. New-conversation text and session reply text
survive navigation; photo attachments remain in memory until sent. Cmd-N
starts a conversation and Cmd-comma opens Settings. Public cockpit links can
be shared to a Mac; Handoff advertises the same link (the receiving device
still needs network reachability and pairing). A local visit marker surfaces
the latest result when a turn finishes while the reader is away.

## Push notifications and Live Activities

Settings → Notifications & activities asks for notification permission only
when the person turns notifications on. Attention and failures are enabled;
completion alerts and session-title previews are separate options. Titles are
hidden in notification and Live Activity payloads by default. A conversation's
menu can mute alerts. Automatic Live Activities are enabled by default, with a
separate Settings toggle. Each Mac starts one Lock Screen / Dynamic Island card
when agent work is active, including while the phone app is in the background.
The card aggregates active sessions, prioritizes work needing input, and ends
when that Mac has no active work. There is no per-session Follow step. Stale activities explicitly say they
are waiting for an update. Finished activities dismiss after five minutes.

The provisioned Mac sends **host → Cloudflare relay → APNs → iPhone**.
Conversations, approvals, and notification registration use the paired host
connection, including Tailscale. The Mac remains the source of session events.
The relay uses the existing Cloudflare Free plan; exceeding its free quotas
stops service rather than enabling a paid plan. See the
[relay setup](../../workers/push-relay/README.md) and
[transport probe evidence](../../workers/apns-probe/README.md).

Deployment credentials remain in GitHub Actions secrets. The APNs key is
supplied to Cloudflare as a Worker secret by the deployment workflow. The Mac
uses its own revocable relay identity in Keychain (`com.telar.push-relay`,
account `host`); only its public hash is registered through GitHub. No credential
is bundled into the iPhone or desktop application. Cockpit startup enables the
Keychain adapter; builds and test imports do not read it.

The existing Apple key supports production `com.telar.mobile` only. Sandbox
and `com.telar.mobile.dev` registrations are unavailable through this relay.
A signed production build is required to verify device delivery.

Direct APNs delivery remains available for a host without a relay identity by
configuring its cockpit process with a protected key file:

```
TELAR_APNS_KEY_ID=<APNs key identifier>
TELAR_APNS_TEAM_ID=<Apple developer team identifier>
TELAR_APNS_KEY_PATH=<absolute path to the APNs .p8 file>
```

Enable Push Notifications for the app's
Apple App ID and regenerate the signing profile before device installation.
The embedded widget has its own bundle ID, `<app bundle id>.activity`.
`TELAR_APP_BUNDLE_ID` is the build override shared by app and extension;
`phone.sh` and `nightly.sh` already pass it. Do not override
`PRODUCT_BUNDLE_IDENTIFIER` globally, which would give both targets one ID.
Debug uses APNs sandbox; Release uses production. This implementation accepts
`com.telar.mobile` and `com.telar.mobile.dev` registrations.

A paired full-access device registers at `PUT /api/mobile/push`. An unpaired
caller is refused even when global pairing enforcement is off. Observer
registration follows the existing read-only gate and is refused. APNs tokens
live in the private `remote/mobile-push.json` file under the chosen TELAR_HOME;
they are never returned by the status endpoint or logged. The Mac must remain
awake with the cockpit running. The Mac makes outbound requests to the relay
(or directly to Apple in direct mode); it needs no inbound public endpoint.

The worker samples the engine's live-session summary every five seconds,
baselines existing history, checkpoints successful alerts, retries delivery
failures with exponential backoff (up to five minutes), and refreshes active cards at most once per minute unless
state changes. It checks device revocation and registration changes again
before sending. This is **snapshot-based**, so a transient state that appears
and disappears between reads can be missed; this is not a durable engine-event
subscription. APNs acceptance is also not proof of delivery to a device.
Removing a Mac attempts to disable its registration and ends local activities;
if it is offline, revoke the phone on that Mac to stop its stored registration.

### Local verification and device acceptance

Run the iOS suite with the commands above, and the push tests with:

```
bun test apps/web/lib/mobile
bun run --cwd apps/web typecheck
```

A local-only UI fixture is available without starting an engine:

```
python3 apps/ios/scripts/preview-server.py
# Launch a Debug build with:
# -mobilePreviewURL http://127.0.0.1:8743 [-openSession design]
```

The preview host book uses a separate defaults suite and an in-memory token
vault, and never reads/writes the normal snapshot cache. The launch argument
is compiled out of Release and accepts only loopback HTTP addresses.

Before shipping, verify a signed device build with the real APNs environment:
background/locked-phone attention, failure and completion delivery; mute and
permission denial; cold-launch routing; Live Activity background updates,
staleness, end and dismissal; and removal/revocation while the Mac is offline.
Check iPad portrait/landscape and narrow resizable windows, keyboard navigation,
large Dynamic Type, light/dark appearances, and restoration of unsent drafts.
Simulator builds and mocked push tests do not replace these device checks.

The `TelarMobileUI` scheme runs native UI smoke tests against the preview
server (start it first). It checks session selection, notification settings,
and Live Activity start/stop. On iPad it also rotates to landscape and asserts
that the conversation column does not overlap the sidebar:

```
xcodebuild -project apps/ios/TelarMobile.xcodeproj -scheme TelarMobileUI \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath /tmp/telar-mobile-tests CODE_SIGNING_ALLOWED=NO test
```

Automatic background starts are verified through host/relay payload tests; a
signed phone is needed to verify Apple creating and updating the card.

Automatic activity starts use Apple's ActivityKit push-to-start token, separate
from both the phone notification token and each card's update token. App startup
observes incoming activities and registers their update tokens with the paired
Mac, including on an APNs background launch. Open the new app once to register
these tokens. Updates still require the phone to reach the Mac for token
registration, and Apple controls Live Activity delivery and background budgets.
A dismissed card is not recreated during the same uninterrupted work period.
