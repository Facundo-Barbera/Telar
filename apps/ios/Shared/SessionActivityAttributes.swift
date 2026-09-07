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
    }
    var hostId: String
    var sessionId: String
    var hostName: String

    var sessionURL: URL {
        var parts = URLComponents()
        parts.scheme = "telar"; parts.host = "session"
        parts.queryItems = [URLQueryItem(name: "host", value: hostId), URLQueryItem(name: "id", value: sessionId)]
        return parts.url!
    }
}
