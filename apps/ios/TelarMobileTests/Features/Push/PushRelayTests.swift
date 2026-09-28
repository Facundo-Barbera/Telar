import Foundation
import Testing
@testable import TelarMobile

@Suite struct PushRelayTests {
    private let macA = HostID()
    private let macB = HostID()

    @Test func pairingAsksOnceAndThenNeverAgain() {
        #expect(NotificationPrompt.shouldAsk(asked: false, enabled: false))

        #expect(!NotificationPrompt.shouldAsk(asked: true, enabled: false))
    }

    @Test func aPersonWhoAlreadySaidYesIsNotAskedOnTheirNextPairing() {
        #expect(!NotificationPrompt.shouldAsk(asked: false, enabled: true))
        #expect(!NotificationPrompt.shouldAsk(asked: true, enabled: true))
    }

    @Test func theLedgerIsNotTheAnswer() {
        #expect(NotificationPrompt.askedKey != "telar.notifications.enabled")
        #expect(!NotificationPrompt.shouldAsk(asked: true, enabled: false))
    }

    @Test func aPhoneThatCannotRegisterSaysSoInOneSentence() {
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
        let direct = PushReadiness(deviceUnsupported: true, notSending: [], unreachable: [])
        #expect(direct.statusLine(enabled: true, allowed: true) == "Push registration saved")
    }

    @Test func aMacThatDidNotAnswerIsADifferentSentence() {
        let away = PushReadiness(notSending: [], unreachable: [macA])
        let line = away.statusLine(enabled: true, allowed: true)
        #expect(line.contains("did not answer"))
    }

    @Test func aMacThatWillNotSendComesFirst() {
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

        #expect(fine.statusLine(enabled: true, allowed: false) == "Notifications are disabled in system Settings")
    }

    @Test func anUnconfiguredMacIsDecodedAsSuch() throws {
        let unconfigured = try JSONDecoder().decode(PushStatus.self, from: Data(#"{"configured":false}"#.utf8))
        #expect(!unconfigured.configured)
        let ready = try JSONDecoder().decode(PushStatus.self, from: Data(#"{"configured":true}"#.utf8))
        #expect(ready.configured)
    }
}
