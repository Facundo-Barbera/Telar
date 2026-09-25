import Foundation

/// GET /api/remote — the cockpit's pairing panel, as the phone sees it.
/// `callerDeviceId` is how "This iPhone" is badged: the server names the
/// caller from its own credential, so the app never stores its own device id.
///
/// THE ADDITIVE RULE (version tolerance, both directions): a field this
/// build doesn't know is ignored by JSONDecoder for free; a field an OLDER
/// cockpit doesn't send yet must never be fatal — anything added after the
/// type first shipped decodes with `decodeIfPresent` + a default. Arrays of
/// records go through `Skippable` so one alien row skips instead of killing
/// the page. Never add a bare `let newField: T` to a shipped model.
struct RemoteStatus: Decodable, Equatable {
    var requireAuth: Bool
    var devices: [RemoteDevice]
    var callerDeviceId: String?
    var callerRole: String?
    /// Every address the Mac answers on, as the Remote access panel lists
    /// them — where a paired phone refreshes its failover list (#832).
    var endpoints: [RemoteEndpoint]

    enum CodingKeys: String, CodingKey {
        case requireAuth, devices, callerDeviceId, callerRole, endpoints
    }

    init(requireAuth: Bool, devices: [RemoteDevice], callerDeviceId: String? = nil, callerRole: String? = nil,
         endpoints: [RemoteEndpoint] = []) {
        self.requireAuth = requireAuth
        self.devices = devices
        self.callerDeviceId = callerDeviceId
        self.callerRole = callerRole
        self.endpoints = endpoints
    }

    /// The addresses worth keeping: never one the Mac marks unsafe to hand a
    /// phone (loopback — from here it dials the phone itself).
    var dialableAddresses: [String] {
        endpoints.filter { $0.qrSafe && $0.kind != "loopback" }.map(\.url)
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Fail CLOSED: an answer that doesn't say the gate is off is treated
        // as the gate being on.
        requireAuth = try container.decodeIfPresent(Bool.self, forKey: .requireAuth) ?? true
        devices = try container.decodeIfPresent([Skippable<RemoteDevice>].self, forKey: .devices)?
            .compactMap(\.value) ?? []
        callerDeviceId = try container.decodeIfPresent(String.self, forKey: .callerDeviceId)
        callerRole = try container.decodeIfPresent(String.self, forKey: .callerRole)
        endpoints = try container.decodeIfPresent([Skippable<RemoteEndpoint>].self, forKey: .endpoints)?
            .compactMap(\.value) ?? []
    }
}

/// One row of the cockpit's `listEndpoints`: "loopback" | "lan" | "tailnet" |
/// "magicdns". `qrSafe` missing reads as unsafe — fail closed.
struct RemoteEndpoint: Decodable, Equatable {
    var kind: String
    var url: String
    var qrSafe: Bool

    enum CodingKeys: String, CodingKey { case kind, url, qrSafe }

    init(kind: String, url: String, qrSafe: Bool) {
        self.kind = kind
        self.url = url
        self.qrSafe = qrSafe
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(String.self, forKey: .kind)
        url = try container.decode(String.self, forKey: .url)
        qrSafe = try container.decodeIfPresent(Bool.self, forKey: .qrSafe) ?? false
    }
}

struct RemoteDevice: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var createdAt: Timestamp?
    var lastSeenAt: Timestamp?
    /// "full" | "observer" — observer may read everything and change nothing.
    /// Cockpits older than roles omit it: everything was full then.
    var role: String
    /// "ios" | "browser", self-declared at pair time; nil for devices paired
    /// before the field existed.
    var platform: String?

    enum CodingKeys: String, CodingKey {
        case id, name, createdAt, lastSeenAt, role, platform
    }

    init(id: String, name: String, createdAt: Timestamp? = nil, lastSeenAt: Timestamp? = nil,
         role: String = "full", platform: String? = nil) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
        self.role = role
        self.platform = platform
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        createdAt = try container.decodeIfPresent(Timestamp.self, forKey: .createdAt)
        lastSeenAt = try container.decodeIfPresent(Timestamp.self, forKey: .lastSeenAt)
        role = try container.decodeIfPresent(String.self, forKey: .role) ?? "full"
        platform = try container.decodeIfPresent(String.self, forKey: .platform)
    }
}
