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
}

/// A decoded element that may be a shape this build does not know.
///
/// The contract requires clients to SKIP unrecognised rows rather than fail
/// the stream. Swift's unkeyed containers advance their index only when an
/// element is consumed, so per-element recovery must swallow the throw inside
/// the element's own decode — which is exactly what this wrapper does.
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
