import Foundation
import UserNotifications

struct DeliveredAlert: Equatable, Sendable {
    var identifier: String
    var threadIdentifier: String
    var url: String?
}

enum ReadSync {
    static let reconcileBatch = 64

    static func reads(from userInfo: [AnyHashable: Any]) -> [ScopedSessionID] {
        guard let read = userInfo["read"] as? [String: Any],
              let host = (read["host"] as? String).flatMap(UUID.init(uuidString:)),
              let sessions = read["sessions"] as? [String] else { return [] }
        return sessions.filter { !$0.isEmpty }.map { ScopedSessionID(hostId: host, sessionId: $0) }
    }

    static func session(of alert: DeliveredAlert) -> ScopedSessionID? {
        if let colon = alert.threadIdentifier.firstIndex(of: ":"),
           let host = UUID(uuidString: String(alert.threadIdentifier[..<colon])) {
            let id = String(alert.threadIdentifier[alert.threadIdentifier.index(after: colon)...])
            if !id.isEmpty { return ScopedSessionID(hostId: host, sessionId: id) }
        }
        return alert.url.flatMap(URL.init(string:)).flatMap(ScopedSessionID.init(url:))
    }

    static func identifiersToRemove(_ delivered: [DeliveredAlert], clearing: Set<ScopedSessionID>) -> [String] {
        guard !clearing.isEmpty else { return [] }
        return delivered.filter { session(of: $0).map(clearing.contains) ?? false }.map(\.identifier)
    }

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

    @discardableResult
    static func clearDelivered(_ sessions: Set<ScopedSessionID>) async -> Bool {
        guard !sessions.isEmpty else { return false }
        let ids = identifiersToRemove(await delivered(), clearing: sessions)
        if !ids.isEmpty { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids) }
        return !ids.isEmpty
    }

    @MainActor static func reconcile(settings: AppSettings) async {
        let queries = reconcileQueries(await delivered())
        var cleared: Set<ScopedSessionID> = []
        for (host, ids) in queries {
            guard let api = settings.api(for: host), let answer = try? await api.readState(ids) else { continue }

            cleared.formUnion(answer.filter(ids.contains).map { ScopedSessionID(hostId: host, sessionId: $0) })
        }
        await clearDelivered(cleared)
    }
}
