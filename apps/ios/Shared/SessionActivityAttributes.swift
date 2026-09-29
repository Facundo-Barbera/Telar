import ActivityKit
import Foundation

struct SessionActivityRow: Codable, Hashable, Identifiable {
    var id: String
    var status: String
    var title: String? = nil
    var project: String? = nil

    var needsYou: Bool { status == "Needs you" }
    var over: Bool { status == "Done" || status == "Failed" }

    static func clip(_ text: String, _ max: Int) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > max else { return trimmed }
        return String(trimmed.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }
}

struct SessionActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var title: String
        var status: String
        var updatedAt: Date
        var startedAt: Date
        var ended: Bool
        var sessionId: String? = nil
        var activeCount: Int? = nil
        var rows: [SessionActivityRow]? = nil
    }
    var hostId: String
    var sessionId: String
    var hostName: String

    func url(sessionId: String?) -> URL {
        if sessionId == nil && self.sessionId == "__automatic__" { return URL(string: "telar://inbox")! }
        var parts = URLComponents()
        parts.scheme = "telar"; parts.host = "session"
        parts.queryItems = [URLQueryItem(name: "host", value: hostId), URLQueryItem(name: "id", value: sessionId ?? self.sessionId)]
        return parts.url!
    }
}
