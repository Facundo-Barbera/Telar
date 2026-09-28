import CryptoKit
import Foundation

struct ActivityReport: Decodable, Equatable {
    struct Start: Decodable, Equatable {
        var at: Double
        var status: Int
        var reason: String?
        var relay: Bool?
        var token: String?
    }
    var card: Bool
    var blocker: String?
    var lastStart: Start?
}

enum LiveActivityDiagnosis {
    static let freshTokenHint = "Turn Live Activities for Telar off and back on in iOS Settings ▸ Telar, then open Telar, so iOS issues a new one."

    static func lines(systemAllowed: Bool, toggle: Bool, hasStartToken: Bool, startTokenRejected: Bool = false, currentToken: String? = nil,
                      macs: [(name: String, report: ActivityReport?)], now: Date = Date()) -> [String] {
        if !systemAllowed { return ["Live Activities are off for Telar in iOS Settings ▸ Telar."] }
        if !toggle { return ["Automatic Live Activities are off."] }
        var lines: [String] = []
        if startTokenRejected { lines.append("Apple no longer accepts the start token iOS gave Telar. \(freshTokenHint)") }
        else if !hasStartToken { lines.append("iOS has not given Telar a push-to-start token, so a card starts only while Telar is open. Once started, your Macs keep it up to date.") }
        for mac in macs { lines.append("\(mac.name): \(line(mac.report, currentToken: currentToken, now: now))") }
        return lines
    }

    static func startTokenMissingAtRelay(_ report: ActivityReport?) -> Bool {
        guard let start = report?.lastStart, report?.card != true else { return false }
        return start.relay == true && start.status == 409 && start.reason == "not_registered"
    }

    static let deadTokenReasons: Set<String> = ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered", "ExpiredToken"]
    static func startTokenRejectedByApple(_ report: ActivityReport?) -> Bool {
        guard let start = report?.lastStart, start.relay != true, report?.card != true else { return false }
        return start.status == 410 || (start.status == 400 && start.reason.map(deadTokenReasons.contains) == true)
    }

    static func line(_ report: ActivityReport?, currentToken: String? = nil, now: Date) -> String {
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
        if startTokenRejectedByApple(report) {
            if let refused = start.token, let currentToken, refused != currentToken {
                return "Apple refused an older start token (\(said), \(ago)). This phone now sends a newer one, which the next start will use."
            }
            if start.token != nil, start.token == currentToken {
                return "Apple refused the start token iOS currently gives Telar (\(said), \(ago)). \(freshTokenHint)"
            }
            return "Apple no longer accepts this phone's start token (\(said), \(ago)). Telar stopped sending it and waits for a new one."
        }
        return "Apple refused the start \(ago) (\(said))."
    }
}

enum StartTokenPolicy {
    static func fingerprint(_ token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }
    static func usable(_ confirmed: String?, rejected: Set<String>) -> String? {
        guard let confirmed, !rejected.contains(fingerprint(confirmed)) else { return nil }
        return confirmed
    }
    static func remember(_ token: String, in rejected: [String], limit: Int = 8) -> [String] {
        remember(print: fingerprint(token), in: rejected, limit: limit)
    }
    static func remember(print: String, in rejected: [String], limit: Int = 8) -> [String] {
        Array((rejected.filter { $0 != print } + [print]).suffix(limit))
    }
}
