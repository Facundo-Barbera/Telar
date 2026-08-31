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
`http://<tailnet IP>:3000`. **`/api` has no auth** — the tailnet ACL is the
entire security boundary, and anything on the tailnet can start turns and
approve tool calls. If `/api` ever grows a token, the app's stored base URL
moves from UserDefaults to Keychain with it.

HTTPS upgrade path: `tailscale serve` publishes an `https://*.ts.net`
endpoint with a real certificate; point the app at that URL and delete the
ATS exception in `Config/Info.plist`. Nothing else changes — the app stores
a full URL, not host/port parts.

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

Open the project in Xcode once, select your team under Signing &
Capabilities (automatic signing), and run to the connected iPhone. A paid
developer account's profile lasts a year; no TestFlight required. The
simulator needs no signing at all and shares the Mac's network stack, so it
reaches the cockpit on either the tailnet IP or localhost.
