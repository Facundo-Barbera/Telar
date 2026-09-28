import Foundation

extension HTTPEngineAPI {
    func registerPush(_ registration: PushRegistration) async throws -> PushStatus {
        try await send("PUT", "api/mobile/push", body: registration)
    }

    func readState(_ ids: [EngineID]) async throws -> [EngineID] {
        struct Answer: Decodable { var cleared: [EngineID] }
        let answer: Answer = try await get("api/mobile/read-state", query: [URLQueryItem(name: "ids", value: ids.joined(separator: ","))])
        return answer.cleared
    }
}
