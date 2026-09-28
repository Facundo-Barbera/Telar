import Foundation

/// Mirrors of `packages/engine-client/src/protocol/common.ts`.
///
/// Timestamps stay epoch-milliseconds `Int` on the wire and in every model —
/// the journal fold compares and maxes them, and a `Date` round-trip would
/// invite drift. Conversion to `Date` happens only at the view.
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
    /// An id from the model's own `serviceTiers`; absent is its default tier.
    var serviceTier: String? = nil
    /// Extra-high reasoning plus standing workflow orchestration — needs a
    /// model that offers `xhigh`. Absent is off.
    var ultracode: Bool? = nil
}

/// Skips an element that fails to decode, so a mistyped field silently drops
/// every row carrying it. Test each new decoded field against JSON copied
/// from a real engine journal.
struct Skippable<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) {
        value = try? T(from: decoder)
    }
}

/// The engine's error body: `{error: {code, message}}` with a stable code set.
struct EngineErrorBody: Codable {
    struct Payload: Codable {
        var code: String
        var message: String
    }
    var error: Payload
}
