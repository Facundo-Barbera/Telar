import Foundation

/// What a Mac says about this phone's automatic Live Activity
/// (`activityReport` in apps/web/lib/mobile/push.ts), carried back on the
/// push registration reply.
struct ActivityReport: Decodable, Equatable {
    struct Start: Decodable, Equatable {
        var at: Double
        var status: Int
        var reason: String?
        var relay: Bool?
    }
    var card: Bool
    var blocker: String?
    var lastStart: Start?
}

/**
 WHY NO LIVE ACTIVITY APPEARED, IN WORDS SOMEBODY CAN ACT ON.

 A card that never shows up has causes on both ends. On the phone: iOS
 Settings, the toggle, a missing push-to-start token. On each Mac: it has not
 tried, Apple refused, or Apple accepted and iOS dropped the start. That last
 case looks like success from the Mac, and without this screen it could only
 be guessed at. Phone causes come first, because they stop every Mac.
 */
enum LiveActivityDiagnosis {
    static func lines(systemAllowed: Bool, toggle: Bool, hasStartToken: Bool,
                      macs: [(name: String, report: ActivityReport?)], now: Date = Date()) -> [String] {
        if !systemAllowed { return ["Live Activities are off for Telar in iOS Settings ▸ Telar."] }
        if !toggle { return ["Automatic Live Activities are off."] }
        var lines: [String] = []
        if !hasStartToken { lines.append("iOS has not given Telar a push-to-start token yet. Open Telar once more with Live Activities allowed.") }
        for mac in macs { lines.append("\(mac.name): \(line(mac.report, now: now))") }
        return lines
    }

    /// A Mac's last start was refused because the relay holds no push-to-start
    /// token for this phone. The phone has one, so the cure is to send it again.
    static func startTokenMissingAtRelay(_ report: ActivityReport?) -> Bool {
        guard let start = report?.lastStart, report?.card != true else { return false }
        return start.relay == true && start.status == 409 && start.reason == "not_registered"
    }

    static func line(_ report: ActivityReport?, now: Date) -> String {
        guard let report else { return "no report (an older Telar on that Mac, or it did not answer)." }
        if report.card { return "card running." }
        switch report.blocker {
        case "off": return "sees Live Activities as off on this phone."
        case "no-start-token": return "has no push-to-start token from this phone yet."
        case "gave-up": return "tried 3 starts and no card appeared; it tries again when work next starts."
        default: break
        }
        guard let start = report.lastStart else { return "waiting for active work to start a card." }
        let ago = RelativeDateTimeFormatter().localizedString(for: Date(timeIntervalSince1970: start.at), relativeTo: now)
        let said = start.reason.map { "\(start.status) \($0)" } ?? "\(start.status)"
        if startTokenMissingAtRelay(report) { return "the push relay had no start token for this phone \(ago); it has been sent again, and the next start will use it." }
        if start.relay == true { return "the push relay refused the start \(ago) (\(said))." }
        if start.status == 200 { return "Apple accepted a start \(ago), but no card appeared. iOS dropped it." }
        return "Apple refused the start \(ago) (\(said))."
    }
}
