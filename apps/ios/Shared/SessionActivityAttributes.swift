import ActivityKit
import Foundation

/// Shared verbatim by the app, widget and APNs payload contract.
struct SessionActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var title: String
        var status: String
        var updatedAt: Date
        var startedAt: Date
        var ended: Bool
        var sessionId: String? = nil
        var activeCount: Int? = nil
    }
    var hostId: String
    var sessionId: String
    var hostName: String

    var sessionURL: URL { url(sessionId: sessionId) }
    func url(sessionId: String?) -> URL {
        if sessionId == nil && self.sessionId == "__automatic__" { return URL(string: "telar://inbox")! }
        var parts = URLComponents()
        parts.scheme = "telar"; parts.host = "session"
        parts.queryItems = [URLQueryItem(name: "host", value: hostId), URLQueryItem(name: "id", value: sessionId ?? self.sessionId)]
        return parts.url!
    }
}
