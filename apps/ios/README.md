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
