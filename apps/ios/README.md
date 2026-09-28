# Telar Mobile

A native SwiftUI client for iPhone and iPad (iOS 18 and later). It shows the Telar inbox, live transcripts, replies, approvals, push notifications and Live Activities.

The app talks only to the cockpit's `/api/**`, never to the engine. The engine stays on loopback and keeps its per-boot token, and the phone authenticates with a device token issued at pairing.

`apps/ios` has no `package.json`, so the Bun workspace tooling ignores it. The project uses file-system-synchronized groups: a new `.swift` file under `TelarMobile/` or `TelarMobileTests/` is built without any edit to the project file.

To build without signing, from the repository root:

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -project apps/ios/TelarMobile.xcodeproj -scheme TelarMobile \
  -destination 'generic/platform=iOS' \
  -derivedDataPath apps/ios/DerivedData CODE_SIGNING_ALLOWED=NO build
```

`apps/ios/phone.sh` installs "Telar Dev" (`io.github.novarix.telar.dev`) on a phone connected by cable.

- Develop and test: [docs/operations/development.md](../../docs/operations/development.md)
- Release through TestFlight, signing and bundle ids: [docs/operations/release-ios.md](../../docs/operations/release-ios.md)
- Push relay: [workers/push-relay/README.md](../../workers/push-relay/README.md)
