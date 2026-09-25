import Foundation
import UserNotifications

/// READ ON THE MAC, GONE FROM THE LOCK SCREEN — the phone's half of read sync.
/// The Mac's half is `apps/web/lib/mobile/read-sync.ts`.
///
/// THREE WAYS AN ALERT COMES DOWN, all through `clearDelivered`:
///   - A SILENT PUSH from the Mac naming sessions read there
///     (`MobileAppDelegate.application(_:didReceiveRemoteNotification:…)`).
///   - THE PHONE ITSELF, when an alert is opened or a session's answer is
///     confirmed read on screen (`ReadReceiptCourier`'s `onRead`).
///   - THE LAUNCH RECONCILE, one request per Mac naming only the sessions that
///     still have alerts, for everything the silent push missed: iOS throttles
///     it, a force-quit app never gets it, and a relay v1 phone is never sent
///     one.
///
/// MATCHED BY `threadIdentifier`, NOT BY REQUEST IDENTIFIER. The Mac sets
/// `apns-collapse-id` = sha256(session id), and iOS uses that as the request
/// identifier — but it names no Mac, so two paired Macs that minted the same
/// session id would share it, and removing by it would take down the other
/// Mac's alert. The alert's `thread-id` is `"<hostId>:<sessionId>"`, which is
/// scoped to the pair; the `url` (`telar://session?host=…&id=…`) says the same
/// and is the fallback. Whatever matches is then removed by its OWN identifier,
/// read back from `deliveredNotifications()`, so nothing depends on guessing
/// how iOS spelled it.

/// The three fields the rule reads off a delivered alert. Not `UNNotification`,
/// which cannot be built in a test.
struct DeliveredAlert: Equatable, Sendable {
    var identifier: String
    var threadIdentifier: String
    var url: String?
}

enum ReadSync {
    /// Ids per reconcile request — the route's own bound (`READ_STATE_MAX`).
    static let reconcileBatch = 64

    /// The sessions a silent push says were read:
    /// `{"read": {"host": "<uuid>", "sessions": ["id", …]}}`. Empty for any
    /// other payload, including an ordinary alert.
    static func reads(from userInfo: [AnyHashable: Any]) -> [ScopedSessionID] {
        guard let read = userInfo["read"] as? [String: Any],
              let host = (read["host"] as? String).flatMap(UUID.init(uuidString:)),
              let sessions = read["sessions"] as? [String] else { return [] }
        return sessions.filter { !$0.isEmpty }.map { ScopedSessionID(hostId: host, sessionId: $0) }
    }

    /// Which Mac's session a delivered alert is about, or nil when it is not a
    /// session alert (the relay test, say).
    static func session(of alert: DeliveredAlert) -> ScopedSessionID? {
        // `UUID(uuidString:)` is case-insensitive, and the phone sends
        // `uuidString` (upper case) while nothing promises it comes back so.
        if let colon = alert.threadIdentifier.firstIndex(of: ":"),
           let host = UUID(uuidString: String(alert.threadIdentifier[..<colon])) {
            let id = String(alert.threadIdentifier[alert.threadIdentifier.index(after: colon)...])
            if !id.isEmpty { return ScopedSessionID(hostId: host, sessionId: id) }
        }
        return alert.url.flatMap(URL.init(string:)).flatMap(ScopedSessionID.init(url:))
    }

    /// The request identifiers to remove so that none of these sessions has an
    /// alert left on screen.
    static func identifiersToRemove(_ delivered: [DeliveredAlert], clearing: Set<ScopedSessionID>) -> [String] {
        guard !clearing.isEmpty else { return [] }
        return delivered.filter { session(of: $0).map(clearing.contains) ?? false }.map(\.identifier)
    }

    /// What the launch reconcile asks each Mac: only sessions with an alert
    /// still showing, de-duplicated, at most one request's worth per Mac.
    static func reconcileQueries(_ delivered: [DeliveredAlert]) -> [HostID: [EngineID]] {
        var queries: [HostID: [EngineID]] = [:]
        for alert in delivered {
            guard let ref = session(of: alert) else { continue }
            var ids = queries[ref.hostId, default: []]
            if ids.count < reconcileBatch && !ids.contains(ref.sessionId) { ids.append(ref.sessionId) }
            queries[ref.hostId] = ids
        }
        return queries
    }

    static func delivered() async -> [DeliveredAlert] {
        await UNUserNotificationCenter.current().deliveredNotifications().map {
            DeliveredAlert(identifier: $0.request.identifier,
                           threadIdentifier: $0.request.content.threadIdentifier,
                           url: $0.request.content.userInfo["url"] as? String)
        }
    }

    /// Take down every delivered alert for these sessions. Returns whether
    /// anything was removed, which is what a background fetch reports.
    @discardableResult
    static func clearDelivered(_ sessions: Set<ScopedSessionID>) async -> Bool {
        guard !sessions.isEmpty else { return false }
        let ids = identifiersToRemove(await delivered(), clearing: sessions)
        if !ids.isEmpty { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids) }
        return !ids.isEmpty
    }

    /// THE SAFETY NET, ON LAUNCH. One request per Mac that has alerts showing,
    /// none for a Mac that has none, and a Mac that does not answer (or is too
    /// old to know the route) simply keeps its alerts.
    @MainActor static func reconcile(settings: AppSettings) async {
        let queries = reconcileQueries(await delivered())
        var cleared: Set<ScopedSessionID> = []
        for (host, ids) in queries {
            guard let api = settings.api(for: host), let answer = try? await api.readState(ids) else { continue }
            // Only what was asked about: a Mac's answer never widens the clear.
            cleared.formUnion(answer.filter(ids.contains).map { ScopedSessionID(hostId: host, sessionId: $0) })
        }
        await clearDelivered(cleared)
    }
}
