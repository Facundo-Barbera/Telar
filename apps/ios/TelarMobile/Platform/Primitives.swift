import Foundation

typealias EngineID = String
typealias Timestamp = Int

extension Timestamp {
    var date: Date { Date(timeIntervalSince1970: Double(self) / 1000) }
}

struct TokenUsage: Codable, Equatable {
    var input: Int
    var output: Int
    var cacheRead: Int
    var cacheCreate: Int
    var reasoning: Int?
}

struct UsageSnapshot: Codable, Equatable {
    var tokens: TokenUsage
    var costUsd: Double?
    var contextUsed: Int?
    var contextMax: Int?
}

struct ModelSelection: Codable, Equatable {
    var instanceId: String
    var model: String?
    var effort: String?
    var fastMode: Bool?
    var serviceTier: String? = nil
    var ultracode: Bool? = nil
}

struct Skippable<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) {
        value = try? T(from: decoder)
    }
}

struct EngineErrorBody: Codable {
    struct Payload: Codable {
        var code: String
        var message: String
    }
    var error: Payload
}
