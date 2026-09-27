import Foundation
import Testing
@testable import TelarMobile

/// WHY NO CARD APPEARED. The phone's own causes stop every Mac, so they come
/// first. After that, each Mac's line has to tell "Apple refused" from "Apple
/// accepted and iOS dropped it", which look the same from the Mac.
@Suite struct LiveActivityDiagnosisTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func start(_ status: Int, reason: String? = nil, relay: Bool = false) -> ActivityReport {
        ActivityReport(card: false, lastStart: .init(at: 1_800_000_000 - 120, status: status, reason: reason, relay: relay))
    }

    @Test func thePhonesOwnCausesComeFirstAndStopTheRest() {
        let macs: [(name: String, report: ActivityReport?)] = [("Studio", ActivityReport(card: true))]
        #expect(LiveActivityDiagnosis.lines(systemAllowed: false, toggle: true, hasStartToken: true, macs: macs, now: now) == ["Live Activities are off for Telar in iOS Settings ▸ Telar."])
        #expect(LiveActivityDiagnosis.lines(systemAllowed: true, toggle: false, hasStartToken: true, macs: macs, now: now) == ["Automatic Live Activities are off."])
        let noToken = LiveActivityDiagnosis.lines(systemAllowed: true, toggle: true, hasStartToken: false, macs: macs, now: now)
        #expect(noToken.first?.contains("push-to-start token") == true)
        #expect(noToken.last == "Studio: card running.")
    }

    @Test func anAcceptedStartWithNoCardSaysIOSDroppedIt() {
        #expect(LiveActivityDiagnosis.line(start(200), now: now).contains("Apple accepted a start"))
        #expect(LiveActivityDiagnosis.line(start(200), now: now).hasSuffix("but no card appeared. iOS dropped it."))
    }

    @Test func aRefusalNamesWhoseAndWhy() {
        #expect(LiveActivityDiagnosis.line(start(400, reason: "BadDeviceToken"), now: now).contains("Apple refused the start"))
        #expect(LiveActivityDiagnosis.line(start(400, reason: "BadDeviceToken"), now: now).hasSuffix("(400 BadDeviceToken)."))
        #expect(LiveActivityDiagnosis.line(start(409, relay: true), now: now).contains("push relay refused"))
    }

    @Test func eachMacBlockerAndSilenceHasItsOwnLine() {
        #expect(LiveActivityDiagnosis.line(ActivityReport(card: false, blocker: "no-start-token"), now: now) == "has no push-to-start token from this phone yet.")
        #expect(LiveActivityDiagnosis.line(ActivityReport(card: false, blocker: "gave-up"), now: now).hasPrefix("tried 3 starts"))
        #expect(LiveActivityDiagnosis.line(ActivityReport(card: false), now: now) == "waiting for active work to start a card.")
        #expect(LiveActivityDiagnosis.line(nil, now: now).hasPrefix("no report"))
    }

    @Test func aStartRefusedNotRegisteredMeansResendTheStartToken() {
        let lost = start(409, reason: "not_registered", relay: true)
        #expect(LiveActivityDiagnosis.startTokenMissingAtRelay(lost))
        #expect(LiveActivityDiagnosis.line(lost, now: now).hasPrefix("the push relay had no start token for this phone"))
        // Anything else is not a lost start token.
        #expect(!LiveActivityDiagnosis.startTokenMissingAtRelay(start(409, reason: "too_many_keys", relay: true)))
        #expect(!LiveActivityDiagnosis.startTokenMissingAtRelay(start(409, relay: true)))
        #expect(!LiveActivityDiagnosis.startTokenMissingAtRelay(start(400, reason: "BadDeviceToken")))
        #expect(!LiveActivityDiagnosis.startTokenMissingAtRelay(ActivityReport(card: true, lastStart: lost.lastStart)))
        #expect(!LiveActivityDiagnosis.startTokenMissingAtRelay(nil))
    }

    @Test func appleRefusingTheStartTokenItselfIsToldApartFromEverythingElse() {
        #expect(LiveActivityDiagnosis.startTokenRejectedByApple(start(410, reason: "Unregistered")))
        #expect(LiveActivityDiagnosis.startTokenRejectedByApple(start(400, reason: "BadDeviceToken")))
        #expect(!LiveActivityDiagnosis.startTokenRejectedByApple(start(400, reason: "PayloadTooLarge")))
        #expect(!LiveActivityDiagnosis.startTokenRejectedByApple(start(410, relay: true)), "the relay's refusal is not Apple's")
        #expect(!LiveActivityDiagnosis.startTokenRejectedByApple(start(200)))
        #expect(LiveActivityDiagnosis.line(start(410, reason: "Unregistered"), now: now).hasPrefix("Apple no longer accepts this phone's start token (410 Unregistered"))
    }

    @Test func aRejectedTokenTellsThePersonHowToGetANewOne() {
        let lines = LiveActivityDiagnosis.lines(systemAllowed: true, toggle: true, hasStartToken: false, startTokenRejected: true, macs: [], now: now)
        #expect(lines == ["Apple no longer accepts the start token iOS gave Telar. \(LiveActivityDiagnosis.freshTokenHint)"])
    }

    @Test func aTokenAppleRefusedIsNeverSentAgainButANewOneIs() {
        let dead = String(repeating: "a", count: 64), fresh = String(repeating: "b", count: 64)
        let rejected = StartTokenPolicy.remember(dead, in: [])
        #expect(StartTokenPolicy.usable(dead, rejected: Set(rejected)) == nil)
        #expect(StartTokenPolicy.usable(fresh, rejected: Set(rejected)) == fresh)
        #expect(StartTokenPolicy.usable(nil, rejected: []) == nil, "nothing confirmed this launch, nothing sent")
        // A fingerprint, not the token, and a bounded list with no repeats.
        #expect(!rejected.contains(dead) && rejected.first?.count == 16)
        #expect(StartTokenPolicy.remember(dead, in: rejected) == rejected)
        var many: [String] = []
        for n in 0..<12 { many = StartTokenPolicy.remember(String(repeating: "c", count: 62) + String(format: "%02d", n), in: many) }
        #expect(many.count == 8)
    }

    @Test func theFingerprintIsTheMacsFormulaAndNamesWhichTokenWasRefused() {
        // Same formula as tokenFingerprint in apps/web/lib/mobile/push.ts.
        #expect(StartTokenPolicy.fingerprint(String(repeating: "b", count: 64)) == "a0fab1377f49a759")
        var old = ActivityReport(card: false, lastStart: .init(at: 1_800_000_000 - 5, status: 410, reason: "Unregistered", relay: false, token: "1111111111111111"))
        #expect(LiveActivityDiagnosis.line(old, currentToken: "2222222222222222", now: now).hasPrefix("Apple refused an older start token"))
        #expect(LiveActivityDiagnosis.line(old, currentToken: "1111111111111111", now: now).hasPrefix("Apple refused the start token iOS currently gives Telar"))
        old.lastStart?.token = nil
        #expect(LiveActivityDiagnosis.line(old, currentToken: "1111111111111111", now: now).hasPrefix("Apple no longer accepts this phone's start token"))
        #expect(StartTokenPolicy.remember(print: "1111111111111111", in: ["1111111111111111"]) == ["1111111111111111"])
    }

    @Test func theMacsReportDecodesAsTheMacSendsIt() throws {
        let json = #"{"configured":true,"activity":{"card":false,"lastStart":{"at":1800000000,"status":200,"relay":false}}}"#
        let status = try JSONDecoder().decode(PushStatus.self, from: Data(json.utf8))
        #expect(status.activity == ActivityReport(card: false, lastStart: .init(at: 1_800_000_000, status: 200, relay: false)))
        #expect(try JSONDecoder().decode(PushStatus.self, from: Data(#"{"configured":false}"#.utf8)).activity == nil)
    }
}
