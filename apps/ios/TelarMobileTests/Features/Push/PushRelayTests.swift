import Foundation
import Testing
@testable import TelarMobile

/// ASKING ONCE, AND SAYING WHY NOTHING ARRIVES — issue #579.
///
/// The owner never got a notification, and no code was broken. This phone never
/// ASKED for permission — the only path to the system prompt was a toggle in
/// Settings ▸ Notifications, so the app had never appeared in iOS's own
/// Notifications list. And a Mac that will send nothing was folded into a
/// count of "unavailable" Macs alongside ones that had simply not replied.
///
/// What must not drift:
///
///   - pairing asks EXACTLY ONCE per install, and never after an answer;
///   - a second Mac does not ask again — the permission is the phone's;
///   - "will not send" and "did not answer" stay apart;
///   - a phone that cannot register with the push relay says so in one
///     sentence, and a phone that merely failed to just now says to retry.
@Suite struct PushRelayTests {
    private let macA = HostID()
    private let macB = HostID()

    // ── ASKING ───────────────────────────────────────────────────────────────

    @Test func pairingAsksOnceAndThenNeverAgain() {
        // The state a fresh install pairs its first Mac in.
        #expect(NotificationPrompt.shouldAsk(asked: false, enabled: false))
        // Having asked, a second Mac must not ask again: iOS shows its alert
        // once per install whatever the app does, so a second call is a silent
        // no-op the app could easily misread as a refusal.
        #expect(!NotificationPrompt.shouldAsk(asked: true, enabled: false))
    }

    @Test func aPersonWhoAlreadySaidYesIsNotAskedOnTheirNextPairing() {
        // They found the toggle before they paired; the question is answered.
        #expect(!NotificationPrompt.shouldAsk(asked: false, enabled: true))
        #expect(!NotificationPrompt.shouldAsk(asked: true, enabled: true))
    }

    @Test func theLedgerIsNotTheAnswer() {
        // "We asked" and "they said yes" are different keys on purpose: a
        // person who said NO is recorded as asked and `enabled == false`, and
        // must not be asked again on the next pairing.
        #expect(NotificationPrompt.askedKey != "telar.notifications.enabled")
        #expect(!NotificationPrompt.shouldAsk(asked: true, enabled: false))
    }

    // ── SAYING WHY ───────────────────────────────────────────────────────────

    @Test func aPhoneThatCannotRegisterSaysSoInOneSentence() {
        // No App Attest (the simulator, an unknown build, a refused
        // attestation): the Mac has nothing to send with, and nothing the
        // person does will change that.
        let unsupported = PushReadiness(deviceUnsupported: true, notSending: [macA, macB], unreachable: [])
        let line = unsupported.statusLine(enabled: true, allowed: true)
        #expect(line == "Notifications can't be set up on this device.")
        #expect(line == PushReadiness.unsupportedLine)
        #expect(!unsupported.isEmpty)
    }

    @Test func aSupportedPhoneThatFailedJustNowIsToldToRetry() {
        let failed = PushReadiness(deviceUnsupported: false, notSending: [macA], unreachable: [])
        let line = failed.statusLine(enabled: true, allowed: true)
        #expect(line != PushReadiness.unsupportedLine)
        #expect(line.contains("Check connection"))
    }

    @Test func anUnsupportedPhoneAMacCanStillReachIsNotAProblem() {
        // A Mac with its own developer key answers `configured: true`.
        let direct = PushReadiness(deviceUnsupported: true, notSending: [], unreachable: [])
        #expect(direct.statusLine(enabled: true, allowed: true) == "Push registration saved")
    }

    @Test func aMacThatDidNotAnswerIsADifferentSentence() {
        let away = PushReadiness(notSending: [], unreachable: [macA])
        let line = away.statusLine(enabled: true, allowed: true)
        #expect(line.contains("did not answer"))
    }

    @Test func aMacThatWillNotSendComesFirst() {
        // A Mac that is away answers later by itself; one that will not send does not.
        let both = PushReadiness(deviceUnsupported: true, notSending: [macA], unreachable: [macB])
        #expect(both.statusLine(enabled: true, allowed: true) == PushReadiness.unsupportedLine)
    }

    @Test func severalUnreachableMacsAreCountedRatherThanRepeated() {
        let two = PushReadiness(notSending: [], unreachable: [macA, macB])
        #expect(two.statusLine(enabled: true, allowed: true).contains("2 Macs"))
    }

    @Test func withNothingWrongItIsTheOrdinaryStatusLine() {
        let fine = PushReadiness()
        #expect(fine.isEmpty)
        #expect(fine.statusLine(enabled: true, allowed: true) == "Push registration saved")
        #expect(fine.statusLine(enabled: false, allowed: true) == "Notifications are off")
        // PERMISSION REVOKED IN SYSTEM SETTINGS is its own answer: the app's
        // own toggle being on says nothing about whether iOS will deliver.
        #expect(fine.statusLine(enabled: true, allowed: false) == "Notifications are disabled in system Settings")
    }

    // ── WHAT THE MAC ANSWERS ─────────────────────────────────────────────────

    @Test func anUnconfiguredMacIsDecodedAsSuch() throws {
        let unconfigured = try JSONDecoder().decode(PushStatus.self, from: Data(#"{"configured":false}"#.utf8))
        #expect(!unconfigured.configured)
        let ready = try JSONDecoder().decode(PushStatus.self, from: Data(#"{"configured":true}"#.utf8))
        #expect(ready.configured)
    }
}
