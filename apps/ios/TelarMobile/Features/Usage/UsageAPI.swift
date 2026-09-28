import Foundation

protocol UsageAPI: Sendable {
    func usageReport(sinceMs: Timestamp, untilMs: Timestamp, resolution: String, timeZone: String) async throws -> UsageReport
}

extension UsageAPI {
    func usageReport(sinceMs: Timestamp, untilMs: Timestamp, resolution: String, timeZone: String) async throws -> UsageReport {
        UsageReport.empty
    }
}

extension HTTPEngineAPI: UsageAPI {
    func usageReport(sinceMs: Timestamp, untilMs: Timestamp, resolution: String, timeZone: String) async throws -> UsageReport {
        struct Wrapped: Decodable { var usage: UsageReport }
        let wrapped: Wrapped = try await get("api/usage", query: [
            URLQueryItem(name: "since", value: String(sinceMs)),
            URLQueryItem(name: "until", value: String(untilMs)),
            URLQueryItem(name: "resolution", value: resolution),
            URLQueryItem(name: "tz", value: timeZone),
        ])
        return wrapped.usage
    }
}
