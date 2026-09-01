import Foundation

/// GET /api/remote — the cockpit's pairing panel, as the phone sees it.
/// `callerDeviceId` is how "This iPhone" is badged: the server names the
/// caller from its own credential, so the app never stores its device id.
struct RemoteStatus: Decodable, Equatable {
    var requireAuth: Bool
    var devices: [RemoteDevice]
    var callerDeviceId: String?
    var callerRole: String?
}

struct RemoteDevice: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var createdAt: Timestamp?
    var lastSeenAt: Timestamp?
    /// "full" | "observer" — observer may read everything and change nothing.
    var role: String
    /// "ios" | "browser", self-declared at pair time; nil for devices paired
    /// before the field existed.
    var platform: String?
}
