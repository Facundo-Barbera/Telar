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
export DEVELOPER_DIR=/Applications/Xcode-26.5.0.app/Contents/Developer
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

Headless, via `apps/ios/phone.sh` (no Xcode GUI):

```
apps/ios/phone.sh nightly   # "Telar" — com.telar.mobile, Release
apps/ios/phone.sh dev       # "Telar Dev" — com.telar.mobile.dev, Debug
```

Two bundle ids make the nightly and the moving dev build UNRELATED APPS to
iOS, so both live on the phone at once — the dev build wears an amber icon
and its own name. Each keeps its own pairing (Keychain is per-app): pair
each once and it survives reinstalls of that flavor. Cutting a nightly is
`git tag nightly-YYYYMMDD && apps/ios/phone.sh nightly` from that tag.

A paid developer account's profile lasts a year; no TestFlight required.
The simulator needs no signing at all and shares the Mac's network stack,
so it reaches the cockpit on either the tailnet IP or localhost.

## Nightlies over TestFlight

`apps/ios/nightly.sh` tags, archives and uploads in one go — the phone then
updates itself through the TestFlight app (internal testing: no review,
live minutes after processing, builds expire after 90 days). One-time
setup, all in the browser:

1. Register the bundle id (developer.apple.com → Identifiers) and create
   the app record in App Store Connect with it.
2. Create an App Store Connect API key (Users & Access → Integrations,
   App Manager role); export `TELAR_ASC_KEY_ID`, `TELAR_ASC_ISSUER_ID`,
   `TELAR_ASC_KEY_PATH` (the downloaded .p8).
3. Add yourself as an internal tester on the app's TestFlight tab and
   install the build from the TestFlight app.

`--no-upload` archives without credentials. The build number is a minute
stamp, so every upload is unique. Keep `phone.sh dev` for the cable-fed
"Telar Dev" beside the TestFlight nightly.
