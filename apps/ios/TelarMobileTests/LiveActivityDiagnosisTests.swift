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

    @Test func theMacsReportDecodesAsTheMacSendsIt() throws {
        let json = #"{"configured":true,"activity":{"card":false,"lastStart":{"at":1800000000,"status":200,"relay":false}}}"#
        let status = try JSONDecoder().decode(PushStatus.self, from: Data(json.utf8))
        #expect(status.activity == ActivityReport(card: false, lastStart: .init(at: 1_800_000_000, status: 200, relay: false)))
        #expect(try JSONDecoder().decode(PushStatus.self, from: Data(#"{"configured":false}"#.utf8)).activity == nil)
    }
}
