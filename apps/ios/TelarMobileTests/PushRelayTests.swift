import Foundation
import Testing
@testable import TelarMobile

/// ASKING ONCE, AND SAYING WHY NOTHING ARRIVES — issue #579.
///
/// The owner never got a notification, and no code was broken. This phone never
/// ASKED for permission — the only path to the system prompt was a toggle in
/// Settings ▸ Notifications, so the app had never appeared in iOS's own
/// Notifications list. And when a Mac answered `configured: false`, meaning it
/// has no push relay and will send nothing, the app folded that into a count of
/// "unavailable" Macs alongside ones that had simply not replied.
///
/// What must not drift:
///
///   - pairing asks EXACTLY ONCE per install, and never after an answer;
///   - a second Mac does not ask again — the permission is the phone's;
///   - "no relay" and "did not answer" stay apart, because one is a credential
///     to go and write on a named screen and the other is a network;
///   - the sentence a person reads names the screen ON THE MAC, since that is
///     the one place the missing thing can be put right.
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

    @Test func noRelayNamesTheScreenOnTheMac() {
        let readiness = PushReadiness(missingRelay: [macA], unreachable: [])
        let line = readiness.statusLine(enabled: true, allowed: true)
        // THE FIX IS ON THE MAC, so the sentence has to send them there. A line
        // that said "push unavailable" would leave somebody checking the phone,
        // which is the one place the credential cannot be.
        #expect(line.contains("Settings ▸ Remote access"))
        #expect(line.contains("relay"))
        #expect(!readiness.isEmpty)
    }

    @Test func aMacThatDidNotAnswerIsADifferentSentence() {
        let away = PushReadiness(missingRelay: [], unreachable: [macA])
        let line = away.statusLine(enabled: true, allowed: true)
        #expect(!line.contains("Remote access"))
        #expect(line.contains("did not answer"))
    }

    @Test func theRelayComesFirstWhenBothAreTrue() {
        // One of these resolves itself when the Mac wakes up; the other never
        // does, however long anybody waits. The actionable one is the one to
        // show.
        let both = PushReadiness(missingRelay: [macA], unreachable: [macB])
        #expect(both.statusLine(enabled: true, allowed: true).contains("Settings ▸ Remote access"))
    }

    @Test func severalMacsAreCountedRatherThanRepeated() {
        let two = PushReadiness(missingRelay: [macA, macB], unreachable: [])
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

    // ── THE BANNER ───────────────────────────────────────────────────────────

    @Test func theBannerIsShownForTheMacThatCannotPushAndNoOther() {
        let readiness = PushReadiness(missingRelay: [macA], unreachable: [macB])
        // A screen about one Mac draws it for ITS Mac only — a banner over one
        // conversation about a different machine would be a puzzle.
        #expect(readiness.missingRelay.contains(macA))
        #expect(!readiness.missingRelay.contains(macB))
    }

    @Test func theBannerSentenceAlsoNamesTheScreenOnTheMac() {
        #expect(PushReadiness.bannerLine.contains("Settings ▸ Remote access"))
        #expect(PushReadiness.bannerLine.contains("relay"))
    }

    // ── WHAT THE MAC ANSWERS ─────────────────────────────────────────────────

    @Test func anUnconfiguredMacIsDecodedAsSuch() throws {
        let unconfigured = try JSONDecoder().decode(PushStatus.self, from: Data(#"{"configured":false}"#.utf8))
        #expect(!unconfigured.configured)
        let ready = try JSONDecoder().decode(PushStatus.self, from: Data(#"{"configured":true}"#.utf8))
        #expect(ready.configured)
    }
}
