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
workspace tooling never sees it. Xcode 27+ required, a RELEASE build (App
Store Connect refuses uploads from a beta); `xcode-select` is not:

```
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -project apps/ios/TelarMobile.xcodeproj -scheme TelarMobile \
  -destination 'generic/platform=iOS' \
  -derivedDataPath apps/ios/DerivedData CODE_SIGNING_ALLOWED=NO build
```

NO SIMULATORS **ON THIS MAC**, by decision (2026-09-11): a runtime is 16 GB and
the phone is the test target here. That decision is about one machine's disk.
It was never about CI, and reading it as a rule for CI is what kept the Swift
suite unrun for as long as it was — GitHub's `macos-26-arm64` image ships iOS
26.2 / 26.4 / 26.5 preinstalled and destroys the runner after every job, so
there is nothing to download and nothing that persists. See "In CI" below.

Locally, then, the unit suite runs on a connected device —
`TELAR_IPHONE_UDID` names it, the same id `phone.sh` installs to:

```
xcodebuild -project apps/ios/TelarMobile.xcodeproj -scheme TelarMobile \
  -destination "platform=iOS,id=$TELAR_IPHONE_UDID" \
  -derivedDataPath apps/ios/DerivedData \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=MM74W7WGAM \
  TELAR_APP_BUNDLE_ID=com.telar.mobile.dev test
```

**`TELAR_APP_BUNDLE_ID` is not optional here, whatever it looks like.**
`xcodebuild test` installs its test host on the phone, and the project
default is `com.telar.mobile` — the TestFlight app's identifier. Without the
override the run replaces the nightly on the phone with a dev-signed build of
whatever is checked out. The `.dev` id is the one `phone.sh` uses, which iOS
treats as an unrelated app, so the TestFlight build is left alone.

### In CI

`verify.yml`'s `Archive iOS` job runs `TelarMobileTests` on
`platform=iOS Simulator,name=iPhone 17`, Debug, `-only-testing:TelarMobileTests`,
on every pull request that touches an iOS path — the same
`ios-changes` guard that decides whether the job takes a Mac at all, so a pull
request touching no iOS file still takes a Linux runner and compiles nothing.
The job archives Release, reports the type-check floor, and then tests, in that
order.

Two assertions, because `xcodebuild test` can exit 0 having executed nothing —
a destination that resolved to something empty, a filter matching no target, a
plan that skipped every suite:

- `passedTests` must be **at least 661**. A floor, not `total > 0`: the check
  this was lifted from failed on `total == 0` and on `failed`, so a run where
  every test was *skipped* and none failed exited 0. Raise the floor when tests
  are added; lowering it to make a red go away is the failure it exists to
  prevent.
- `environmentDescription` is printed, so the runtime the run landed on is in
  the log. That is the cheap way to notice an image change.

#### Why the device nightly is gone

`.github/workflows/nightly-ios-tests.yml` was added 2026-09-19 (#675), parked a
day later (#755), and deleted 2026-09-20. It is worth knowing why, because the
file read like coverage and was not:

- **It never ran. Not once.** Its `schedule:` was on `main` from 20:18 UTC on
  2026-09-19 to 04:47 UTC on 2026-09-20 with a cron of `23 16 * * *`; there is
  no 16:23 UTC inside that window. GitHub's run count for the workflow was 0
  for its whole life, against 1162 for `verify.yml`.
- **It could not have run after CI moved off the Mac mini.** `runs-on:
  [self-hosted, macOS, ARM64, telar-nightly]` matches no runner registered on
  this repository, and a dispatch against a label nothing carries queues for
  ever rather than failing. That is what the `if: false` guard was for.
- **The arrangement it needed is the one #754 removed** — a machine with a
  phone cabled to it, which was also a single point of failure for all of CI:
  53-minute queues, and `main` 27 commits without a green.

Nothing in the suite asserts anything only hardware can produce, so the
simulator leg is not a weaker substitute — it is the same 661 assertions on a
runtime that does not depend on a cable. The manual device command above still
works and stays the answer for anyone who wants the phone in the loop.

**The trigger to revisit is not "more TestFlight users."** More users do not
make a device necessary, because no test needs one. The trigger is the first
test that asserts something only hardware produces — real push delivery, a Live
Activity on the Lock Screen, background execution, thermal behaviour. At that
point the honest arrangement is a paid device cloud or a human running the
command above before a release, not a runner on somebody's desk.

If a simulator is ever wanted *on this Mac*, `xcodebuild -downloadPlatform iOS`
fetches the runtime; delete it with `xcrun simctl runtime delete all`.

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

## Nightlies over TestFlight

Cutting a nightly is pushing a tag:

```
git tag ios-nightly-YYYYMMDD && git push origin ios-nightly-YYYYMMDD
```

The Actions workflow (.github/workflows/nightly-ios.yml) runs
`apps/ios/nightly.sh` on the Mac mini's own self-hosted runner, with its one
release Xcode: archive, export (the re-sign to Apple Distribution —
`destination: upload` ships a dev-signed binary Apple refuses), altool
upload. The phone then updates itself through the TestFlight app (internal
testing: no review, live minutes after processing, builds expire after 90
days). Why the Mac and not GitHub's macOS lane, and how every other workflow
came to live there too: docs/operations/mac-mini-runner-plan-2026-09-11.md.

Credentials are the repo secrets `APPLE_API_KEY_P8_BASE64` /
`APPLE_API_KEY_ID` / `APPLE_API_ISSUER` — an ADMIN App Store Connect API
key (cloud signing refuses less), shared with desktop notarization.
`nightly.sh --no-upload` archives without them, for debugging.

## Mobile experience (iPhone and iPad)

The app is universal (iOS/iPadOS 18+). Its sidebar follows the desktop's
attention → pins → project groups → Snoozed / Settled structure, with saved
text drafts first. Search includes every session shelf. Mac and project filters
narrow the list; a session retains its host-qualified identity throughout
navigation, notification taps, and local Live Activity links.

Each band announces itself the way the desktop's does. **Needs you** wears a
dot, the small uppercase caption and its count; **Snoozed** and **Settled** are
the desktop's `BandRule` — chevron, caption, a hairline out to the count. A
project's header carries its avatar, its name at header weight, its Mac when
there is more than one, and the number of rows it is showing; its long-press
menu starts a conversation in that project (the desktop reveals a `+` on
hover, which touch has no equivalent for) alongside Move up/down. A card in a
live band wears a hairline on its leading edge in the status colour — amber
when it is waiting on you, accent while it works. The footer is a muted gear,
not a full-width button; there is no Usage page on the phone and no update
control, because this app updates through TestFlight.

Two things deliberately differ from the desktop. The title is **large** at both
widths, so the search field lands in a navigation-bar drawer under it rather
than collapsing into the bar beside the toolbar buttons. And a slim row's
project mark keeps its colour at rest: the desktop desaturates it and restores
it on hover, and touch has no hover to restore it with.

Project ordering reads and writes each Mac's `/api/sidebar-layout` document.
Drag a project onto another project on the same Mac, or use its context menu's
Move up/down actions. Hidden project keys are preserved. Cross-Mac global
ordering is not synchronized: host IDs belong to each cockpit's host book, so
one cockpit's remote-host keys cannot be reused as this phone's UUIDs.

On iPad the sidebar and conversation share a split view; the panel opens as an
inspector column on a regular-width display. Compact windows and iPhone push it
full-screen instead. New-conversation text and session reply text
survive navigation; photo attachments remain in memory until sent. Tapping or
scrolling the conversation puts the keyboard away. Cmd-N
starts a conversation and Cmd-comma opens Settings. Public cockpit links can
be shared to a Mac; Handoff advertises the same link (the receiving device
still needs network reachability and pairing).

## The panel

A conversation's menu opens **Panel**, the phone's version of the desktop
cockpit's right panel. It carries four surfaces; Data and LaTeX appear only when
the session's project has that plugin enabled, which the app learns from
`GET /api/projects` the same way the web does.

- **Diff** — the working tree's changes, the view Changes used to open.
- **Files** — the checkout as a tree (directories first, natural order, single
  child chains collapsed) beside the open file. Code and binaries are read-only
  monospace with line numbers; Markdown and plain text are editable with a
  sha256 precondition, a 600 ms autosave and the engine's own refusal sentence
  when the file moved underneath. Notebooks render as cells with outputs,
  `.csv`/`.tsv`/`.parquet` as a windowed grid, PDFs through PDFKit, images as
  themselves.
- **Data** — plots from the session's attachments, kernel variables with an
  inspector, and the Python environment. The kernel's pill, Interrupt and
  Restart sit at the strip's trailing edge.
- **LaTeX** — compile a target, read the diagnostics as rows that open their own
  file in Files, and open the built PDF.

The panel is a trailing column on a regular width and a full-screen push on a
compact one. Where the window cannot hold sidebar, conversation and panel at
once — an iPad in portrait — opening the panel stands the sidebar aside and
closing it brings the sidebar back. Which tab is up, which files are open and
whether the panel is showing are remembered per Mac **and** session, since two
Macs can mint the same session id.

Inside the panel the tree and the open file share the width below 560 pt: the
strip's leading toggle is the way between them, and opening a file — from the
tree, from a transcript chip's *Open in panel*, or from a `display.opened` event
the agent sent — shows the file. A `display.opened` only counts when it is newer
than the moment the conversation was opened; the journal replays from zero on
every load, and without that guard every reload would re-open last week's file.

Presentation is driven by `@State` flags rather than a computed `Binding`.
`.inspector` keeps its `isPresented` binding and compares it to decide whether
the split view needs another update, so a `Binding(get:set:)` built in `body` is
a new location on every pass: the inspector re-updated, that dirtied layout,
layout re-ran `body`, and the app's first CoreAnimation commit never converged.

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

### Wire-facing changes

**Every new decoded field ships with one test whose JSON is copied verbatim
from the live journal — never from a fixture the author wrote.**

```
sqlite3 ~/Library/Application\ Support/Telar/engine/execution.sqlite \
  "select value from events where value like '%\"origin\":\"provider\"%' limit 1;"
```

The reason is that this app's snapshot lists decode through `Skippable`, which
swallows a decode failure and drops the row. That is the right behaviour for a
shape the build does not know — and it cannot tell that case apart from a field
*we* declared with the wrong type. A single wrong optional does not fail
loudly; it deletes every row carrying that field, silently.

It has happened: `Turn.wakeReason` was `String?` while the engine sends an
object, so every wake-up turn vanished from the transcript on every read while
the suite stayed green, because the fixture asserted the shape the author had
imagined. A fixture can only confirm what someone already believed; the journal
is the only thing that can contradict it.

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
that the conversation column does not overlap the sidebar. With no simulator
on the Mac these run on a connected device, which must reach the preview
server over the network (the tailnet address, not loopback):

```
xcodebuild -project apps/ios/TelarMobile.xcodeproj -scheme TelarMobileUI \
  -destination "platform=iOS,id=$TELAR_IPHONE_UDID" \
  -derivedDataPath /tmp/telar-mobile-tests \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=MM74W7WGAM \
  TELAR_APP_BUNDLE_ID=com.telar.mobile.dev test
```

Same reason as the unit suite: this drives the real app on the phone, so
without the `.dev` override it installs over the TestFlight build. The UI
scheme is deliberately NOT in the nightly CI job — it needs `preview-server.py`
running and reachable from the phone, and a CI step that waits on a server
nobody started is a hang, not a test.

Automatic background starts are verified through host/relay payload tests; a
signed phone is needed to verify Apple creating and updating the card.

Automatic activity starts use Apple's ActivityKit push-to-start token, separate
from both the phone notification token and each card's update token. App startup
observes incoming activities and registers their update tokens with the paired
Mac, including on an APNs background launch. Open the new app once to register
these tokens. Updates still require the phone to reach the Mac for token
registration, and Apple controls Live Activity delivery and background budgets.
A dismissed card is not recreated during the same uninterrupted work period.
