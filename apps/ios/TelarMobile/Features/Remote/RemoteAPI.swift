import Foundation

protocol RemoteAPI: Sendable {
    func remoteStatus() async throws -> RemoteStatus
    func renameDevice(_ id: String, name: String) async throws -> RemoteDevice
    func setDeviceRole(_ id: String, role: String) async throws -> RemoteDevice
    func revokeDevice(_ id: String) async throws
    func revokeOtherDevices() async throws -> Int
}

extension HTTPEngineAPI: RemoteAPI {
    func remoteStatus() async throws -> RemoteStatus {
        try await get("api/remote")
    }

    private struct WrappedDevice: Decodable { var device: RemoteDevice }

    func renameDevice(_ id: String, name: String) async throws -> RemoteDevice {
        let wrapped: WrappedDevice = try await send("PATCH", "api/remote/devices/\(escape(id))", body: ["name": AnyEncodable(name)])
        return wrapped.device
    }

    func setDeviceRole(_ id: String, role: String) async throws -> RemoteDevice {
        let wrapped: WrappedDevice = try await send("PATCH", "api/remote/devices/\(escape(id))", body: ["role": AnyEncodable(role)])
        return wrapped.device
    }

    func revokeDevice(_ id: String) async throws {
        let _: IgnoredBody = try await delete("api/remote/devices/\(escape(id))")
    }

    func revokeOtherDevices() async throws -> Int {
        struct Wrapped: Decodable { var revoked: Int }
        let wrapped: Wrapped = try await delete("api/remote/devices")
        return wrapped.revoked
    }
}
