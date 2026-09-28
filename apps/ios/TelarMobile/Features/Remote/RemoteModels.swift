import Foundation

struct RemoteStatus: Decodable, Equatable {
    var requireAuth: Bool
    var devices: [RemoteDevice]
    var callerDeviceId: String?
    var callerRole: String?

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

    var dialableAddresses: [String] {
        endpoints.filter { $0.qrSafe && $0.kind != "loopback" }.map(\.url)
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        requireAuth = try container.decodeIfPresent(Bool.self, forKey: .requireAuth) ?? true
        devices = try container.decodeIfPresent([Skippable<RemoteDevice>].self, forKey: .devices)?
            .compactMap(\.value) ?? []
        callerDeviceId = try container.decodeIfPresent(String.self, forKey: .callerDeviceId)
        callerRole = try container.decodeIfPresent(String.self, forKey: .callerRole)
        endpoints = try container.decodeIfPresent([Skippable<RemoteEndpoint>].self, forKey: .endpoints)?
            .compactMap(\.value) ?? []
    }
}

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

    var role: String

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
