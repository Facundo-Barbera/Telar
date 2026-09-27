import CryptoKit
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
        /// Fingerprint of the start token that start used (`StartTokenPolicy.fingerprint`).
        var token: String?
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

    /// A Mac's last start was refused because the relay holds no push-to-start
    /// token for this phone. The phone has one, so the cure is to send it again.
    static func startTokenMissingAtRelay(_ report: ActivityReport?) -> Bool {
        guard let start = report?.lastStart, report?.card != true else { return false }
        return start.relay == true && start.status == 409 && start.reason == "not_registered"
    }

    /// Apple's answer to a start says the token itself is gone, not a bad moment.
    static let deadTokenReasons: Set<String> = ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered", "ExpiredToken"]
    static func startTokenRejectedByApple(_ report: ActivityReport?) -> Bool {
        guard let start = report?.lastStart, start.relay != true, report?.card != true else { return false }
        return start.status == 410 || (start.status == 400 && start.reason.map(deadTokenReasons.contains) == true)
    }

    /// `currentToken` is the fingerprint of the token this phone sends now, if any.
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
            // WHICH TOKEN APPLE REFUSED decides what helps: an old one is already
            // replaced; the one iOS issues now needs iOS to issue another.
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

/**
 WHICH PUSH-TO-START TOKEN THE PHONE MAY SEND.

 A token counts only once iOS has handed it over during this launch, through
 `Activity.pushToStartToken` or `pushToStartTokenUpdates`. A copy cached by an
 earlier build outlived the build that minted it: sent again after an update,
 Apple answered 410 Unregistered. The relay dropped it, and the phone sent the
 same copy back on its next sync, for ever.

 A token Apple has refused is never sent again, even if iOS reports it
 unchanged. Only a short fingerprint is kept, never the token.
 */
enum StartTokenPolicy {
    static func fingerprint(_ token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }
    static func usable(_ confirmed: String?, rejected: Set<String>) -> String? {
        guard let confirmed, !rejected.contains(fingerprint(confirmed)) else { return nil }
        return confirmed
    }
    /// Newest last, bounded: one entry per token Apple refused.
    static func remember(_ token: String, in rejected: [String], limit: Int = 8) -> [String] {
        remember(print: fingerprint(token), in: rejected, limit: limit)
    }
    static func remember(print: String, in rejected: [String], limit: Int = 8) -> [String] {
        Array((rejected.filter { $0 != print } + [print]).suffix(limit))
    }
}
