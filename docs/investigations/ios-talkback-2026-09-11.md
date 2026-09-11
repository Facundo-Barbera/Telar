# Reading the agent's last reply aloud on iPhone

Investigation only. No app source was changed. API claims marked **[probe]** come
from a throwaway SwiftPM package run on the iPhone 17 Pro simulator under
`DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer` (Xcode 27.0,
build 27A5252f), iOS 18 deployment target, matching the app.

## 1. The text

**Where the last reply lives.** Two representations, both already decoded:

- `Turn.resultText` (`apps/ios/TelarMobile/Protocol/TurnModels.swift:44`) — the
  engine's own final text for a turn. Folded to `JournalTurn.resultText`
  (`Sync/Journal.swift:104`) from the snapshot (`Journal.swift:215`) and from the
  `turnCompleted` event (`Journal.swift:310-313`).
- `ItemDetail.assistantMessage(text:)` items (`Protocol/ItemModels.swift:104`,
  decoded at `:135-136`), read through `JournalItem.text`
  (`Sync/Journal.swift:28-36`) — streamed deltas win while the item is open, the
  stored detail once it closes.

**Which one to speak.** The transcript's own answer is the *last* assistant
message item: `TurnView.split` (`Views/TranscriptViews.swift:71-78`) cuts the
answering response at `items.lastIndex { assistantMessage }` and draws that tail
as `closing` (`:148-150`). Speaking those closing items speaks exactly what is on
screen. `resultText` is the fallback when a turn carries no assistant item.

**Which turn.** Do not invent a third notion of "the last answer" — the app
already pins one. `newestResultTurn` (`Stores/ReadReceipt.swift:55-61`) picks the
newest turn by engine `sequence` among states `isResultTurn` allows
(`ReadReceipt.swift:46-48`: `completed`, `failed`, `stopped`). Reuse it.

**Markdown.** The reply is GFM plus `$$…$$` TeX. Rendering path: `splitMath`
(`Views/MathSegments.swift:29`) cuts math out first, then MarkdownUI draws prose,
fenced code (`Views/MarkdownText.swift:232-259`) and tables (`:261-280`).

MarkdownUI 2.4.1 exposes `MarkdownContent.renderPlainText()` publicly
(`Sources/MarkdownUI/DSL/Blocks/MarkdownContent.swift:107`; the package is pinned
at `TelarMobile.xcodeproj/project.pbxproj:247`). **It is not a speakable pass.**
[probe] Feeding it a representative reply returns:

```
Here is the answer, with inline code and a link.   <- emphasis + URL gone, good
func hello() {                                     <- code body VERBATIM
    print("secret internals")
}
|Name|Count|                                       <- table as pipe rows
| --- | --- |
|alpha|1|
  - first bullet                                   <- fine
a quote                                            <- fine
And $$E = mc^2$$ inline math.                      <- TeX UNTOUCHED
A heading                                          <- fine
```

A synthesizer reading that says "pipe alpha pipe one pipe" and spells out braces.
The block tree cannot be walked instead: `MarkdownContent.blocks` is internal
(`MarkdownContent.swift:74`) and `BlockNode` is an internal enum.

So a new pass is needed — a pure `speakableText(_ markdown: String) -> String`.
It can copy the line walk already in `MathSegments.swift`: fence toggling at
`:48-58`, backtick-span tracking at `:108-109` and `:161-165`. Policy per element:

| Element | Spoken |
| --- | --- |
| Prose, headings, list items, block quotes | read (drop `#`, `*`, `>` markers) |
| Fenced code | "a code block" (or "a swift code block, 8 lines") — never the body |
| Inline `code` | read the identifier as-is; it is usually one word |
| Table | "a table, 2 rows" |
| `$$…$$` | "an equation" |
| Link | link text only (`renderPlainText` already drops the URL) |
| Image | alt text |

Note the precedent *not* to copy: `MathBlock` sets `accessibilityLabel(tex)`
(`MarkdownText.swift:92`), so VoiceOver already reads raw TeX aloud today.

**Streaming vs settled.** Speak the **settled** reply only. Three reasons from
the code: the reveal pacer is presentation-only and its progress is a *guess*
about arrival rate (`Views/StreamingReveal.swift:3-5`); a revised answer can
*replace* what was already shown (`isReplacement`, `StreamingReveal.swift:187-189`)
and audio cannot be un-said; and a half-arrived construct is an expected state —
`MathBlock` explicitly renders `\frac{1}{` as its own source until the brace
lands (`MarkdownText.swift:94-96`). Trigger on the turn leaving
`TurnState.isActive` (`TurnModels.swift:18-20`), which is the same edge
`StreamingMarkdown` uses to stop pacing (`Views/StreamingMarkdown.swift:90-97`).

## 2. The engine

**`AVSpeechSynthesizer`, on-device.** Probe results on the simulator:

- [probe] 68 voices across 49 languages, **every one `quality == .default`** —
  zero `.enhanced`, zero `.premium`. The tiers exist in the SDK
  (`AVSpeechSynthesis.h:22-26`) but are downloads (Settings → Accessibility →
  Spoken Content → Voices). A fresh phone therefore sounds like Samantha
  (`com.apple.voice.super-compact.en-US.Samantha`): intelligible, plainly robotic.
  This is the honest cost of the on-device route.
- [probe] **Speech works in the simulator**: `didStart` and `didFinish` both
  fired, with 10 `willSpeakRangeOfSpeechString` callbacks for a 10-word utterance.
- [probe] `pauseSpeaking(at: .word)`, `continueSpeaking()` and
  `stopSpeaking(at: .immediate)` all return `true`, with `didPause`/`didContinue`
  delivered. Boundaries at `AVSpeechSynthesis.h:17-19`.
- [probe] `write(_:toBufferCallback:)` renders offline — 26,268 PCM frames, no
  audio session — if an export or a pre-render is ever wanted.
- [probe] `personalVoiceAuthorizationStatus == 2` (`unsupported`) on the
  simulator. Personal Voice is device-only.
- `prefersAssistiveTechnologySettings` (`AVSpeechSynthesis.h:206-210`) makes an
  utterance follow the *user's* voice and rate when an assistive technology is
  on. [probe] settable. Set it.
- Language: [probe] `currentLanguageCode()` returned `en-US`, but that is the
  system language, not the reply's. If replies can be non-English, one
  `NLLanguageRecognizer` call per reply picks the voice; otherwise hardcode.

**Server-side TTS: no.** The phone already speaks HTTP to the cockpit
(`Networking/EngineAPI.swift:316`), so it is *possible*. Against it: it needs a
new `/api` route, exactly the surface the README's wire rule guards; the Mac must
be awake and reachable, which the README already lists as a limitation of push;
`say` on the Mac plays audio *on the Mac*, so it needs capture, transfer and
playback anyway; and a cloud voice adds a credential to an app whose README
states "No credential is bundled into the iPhone or desktop application". The
only thing it buys is voice quality. Not for v1.

**Speak Screen / Speak Selection: be honest — they already half-solve this.**
The transcript enables text selection (`MarkdownText.swift:39`), so today a user
*can* long-press a reply, select it, and tap Speak. That works now, for free.
What it does not do: it reads raw Markdown including fence bodies; it cannot be
aimed at "the last reply" without a selection gesture per reply; Speak Screen
reads the *whole* screen from the top, toolbar and fold labels included; and
neither works hands-free. Aiming and hands-free are what an in-app control
actually buys. Skipping code blocks is a nicety, not the justification.

## 3. The gesture, ranked

**1. An App Intent, declared in the app target.** This is the one that matches
"on the phone" meaning "not looking at it" — Siri, the lock screen, the Action
button, CarPlay, a Shortcut.

The architectural detail that decides this: there is **no App Group** and no
keychain access group (`Config/TelarMobile.entitlements` holds only
`aps-environment`), and the Keychain service is scoped to the bundle id
(`Stores/KeychainStore.swift:19`). A separate App Intents *extension* could
therefore not read the device token and could not call the cockpit. An
`AppIntent` declared in the **app target** runs in the app's own process, where
the token is readable — and it is stored `kSecAttrAccessibleAfterFirstUnlock`
(`KeychainStore.swift:50`) precisely so a background refresh can authenticate
while the phone is locked. So this needs **no entitlement and no Info.plist
change**. It does need a session to target: a parameter, defaulting to the most
recently active session.

**2. A control in the existing session menu.** `SessionView.swift:622-662`
already holds Mute / Continue on your Mac / Panel / Rename / Settle. One more
`Button("Speak the last reply", systemImage: "speaker.wave.2")` is ~8 lines, zero
layout risk, and discoverable. This is the right v1 UI.

**3. A button on the last assistant message.** Natural target — `TurnView` draws
`closing` at `TranscriptViews.swift:148-150`. Costs real layout work and puts a
control on every turn to serve the last one.

**4. Long-press the message.** Already contended: MarkdownUI claims
`.contextMenu` on code blocks (`MarkdownText.swift:256`) and text selection owns
long-press on prose (`:39`). Fragile.

**5. A toolbar item.** The bar already carries the panel toggle and the overflow
(`SessionView.swift:606-662`), and on compact width there is no room.

**6. A Live Activity action.** The card has no buttons, only `widgetURL`
(`TelarActivity/TelarActivity.swift:35`, `:58`). `Button(intent:)` is available,
but the card is host-aggregated — `sessionId == "__automatic__"`
(`Activities/MobileNotifications.swift:77`) with a nullable per-state session
(`Shared/SessionActivityAttributes.swift:12`, `:20-26`) — so "the last reply" has
no unambiguous target. Skip.

**7. Shake.** Undiscoverable, collides with shake-to-undo. No.

## 4. Audio session and platform rules

**Background mode is not set today.** `Config/Info.plist` (35 lines) has no
`UIBackgroundModes`, and the pbxproj sets no `INFOPLIST_KEY_UIBackgroundModes`
(zero matches). So without a change, speech stops when the app backgrounds or the
screen locks.

**The cheapest correct v1 writes no session code at all.** Set
`synth.usesApplicationAudioSession = false`. The header
(`AVSpeechSynthesis.h:259-263`) says the synthesizer then uses a separate session
that "will mix and duck other audio, and its active state will be managed
automatically". [probe] Verified: with the shared session explicitly deactivated
and no setup, the utterance started and finished. Ducking and interruptions
become Apple's problem.

**If the app takes its own session** (required for background audio):
`.playback` + `.spokenAudio`, optionally `.duckOthers`. [probe] `setCategory`
accepted `.duckOthers` with both `.spokenAudio` and `.default` (resulting options
raw value 3). One product decision: `.playback` plays **through the mute switch**.
For a deliberate "read this to me" tap that is arguably right; it is still a
surprise. `.ambient` respects the switch but is ducked by other audio.

**Interruptions have an SDK seam.** `AVAudioSessionInterruptionNotification` is
deprecated in this SDK — `API_DEPRECATED(..., ios(6.0, 27.0))`,
`AVAudioSessionTypes.h:229` — replaced by
`AVAudioSession.didBecomeInactiveNotification` and
`.resumptionRecommendationNotification`, both `API_AVAILABLE(ios(27.0))`
(`AVAudioSessionTypes.h:316`, `:321`). The app deploys to iOS 18.0
(`project.pbxproj:277`), so an own-session implementation needs both paths behind
`if #available` or it ships a deprecation warning. Another argument for
`usesApplicationAudioSession = false` in v1.

**iPad.** `TARGETED_DEVICE_FAMILY = "1,2"` (`project.pbxproj:339`); same APIs. The
only layout consequence: on a regular width the conversation shares the window
with the sidebar and the panel inspector, so the control must not live in the
panel column.

**VoiceOver.** If `UIAccessibility.isVoiceOverRunning`, the app speaking over
VoiceOver is a bug — two voices collide and VoiceOver is already reading the
message. So: never auto-start while it is on. Set
`utterance.prefersAssistiveTechnologySettings = true` so rate and voice follow the
user's Spoken Content settings. And follow the transcript's existing instinct —
`ReadReceiptMarker` is `accessibilityHidden` because it is a position, not content
(`TranscriptViews.swift:47-57`) — so a Speak button needs a real
`accessibilityLabel`, and the speakable text must not be stuffed into one.

## 5. Size of the work

| Stage | Files | ~Lines | Device needed |
| --- | --- | --- | --- |
| A. In-app Speak | new `Views/SpeakableText.swift`, new `Stores/Talkback.swift`, `Views/SessionView.swift` (+8), new `TelarMobileTests/SpeakableTextTests.swift` | ~250 | mute switch, AirPods/CarPlay route, ducking against real music |
| B. + App Intent | new `Intents/ReadLastReply.swift` + `AppShortcutsProvider` | ~100 | **yes** — Siri phrase, lock screen, Action button |
| C. + Background audio | `Config/Info.plist` (1 key), session + interruption handling with the iOS 27 split | ~60 | **yes** — screen lock, call interruption |

The speakable pass is a pure function, so it tests the way the other pure passes
already do — `TelarMobileTests/MathSegmentsTests.swift` and
`StreamingRevealTests.swift` are the models.

[probe] **The simulator is enough to verify the mechanism.** Speech ran there
(section 2), so `speakableText` → utterance → `didFinish` can be exercised in
`xcodebuild test` without hardware. What the simulator cannot show: installed
enhanced/premium voices (it has none), the mute switch, Bluetooth/CarPlay
routing, real ducking, background/locked continuation, Siri matching, and the
Action button.

**The wire rule does not apply.** `apps/ios/README.md:221-241` requires a
journal-copied fixture test for every newly decoded field, because `Skippable`
silently drops a row whose type is wrong. Talkback decodes nothing new: it reads
`Turn.resultText` and `assistant_message` items that already decode and already
have tests. Worth stating in the PR so a reviewer does not ask for a fixture.

## 6. Recommendation

Build it on-device with `AVSpeechSynthesizer`, staged A → B → C, and commit only
as far as B. Stage A is a pure `speakableText` pass plus a "Speak the last reply"
item in the session menu, speaking the settled turn chosen by `newestResultTurn`,
with `usesApplicationAudioSession = false` so there is no audio-session code and
no interruption handling to get wrong: ~250 lines, four files, no Info.plist
change, no wire change, fully unit-testable. Stage B adds an App Intent **in the
app target** — the part that actually answers "when they are on the phone", since
it works from Siri and the lock screen, and it needs no entitlement because the
app's own process already holds an `AfterFirstUnlock` Keychain token. Stage C
(background audio) is the only stage that changes what the app claims to the
system and should wait for someone to confirm they want speech to survive a
screen lock. The one thing to verify first on a real phone, before writing any of
stage A's UI: **speak a long reply through the stock voice with music playing and
AirPods connected**. The simulator has no enhanced voices and no real route, and
if Samantha is too poor to listen to for a paragraph then the whole feature is a
Speak Selection shortcut in a trench coat and the Mac-side TTS tradeoff deserves
a second look.

## What could not be determined without a device

Voice quality on real hardware and whether enhanced/premium voices are installed;
mute-switch behaviour; Bluetooth, CarPlay and car-stereo routing; ducking against
actually-playing audio; whether speech survives backgrounding and screen lock;
Siri phrase matching and Action button assignment; Personal Voice availability.
