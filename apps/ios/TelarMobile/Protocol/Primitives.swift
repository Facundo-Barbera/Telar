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

/// A decoded element that may be a shape this build does not know.
///
/// The contract requires clients to SKIP unrecognised rows rather than fail
/// the stream. Swift's unkeyed containers advance their index only when an
/// element is consumed, so per-element recovery must swallow the throw inside
/// the element's own decode — which is exactly what this wrapper does.
///
/// WHAT IT PROTECTS AGAINST IS AN UNKNOWN FIELD, NOT A FIELD WE TYPED WRONG.
/// It cannot tell those apart: both throw, and both are swallowed. A single
/// optional declared with the wrong type therefore does not fail loudly — it
/// DELETES EVERY ROW THAT CARRIES THAT FIELD, silently, forever.
///
/// That is not hypothetical. `Turn.wakeReason` was declared `String?` while the
/// engine sends an object; the result was not a wrong label, it was every
/// wake-up turn vanishing from the transcript on every read, with a green test
/// suite the whole time, because the fixtures asserted the shape the author had
/// imagined rather than the one on the wire.
///
/// So: a new decoded field ships with a test whose JSON is copied VERBATIM from
/// the live journal. See "Wire-facing changes" in apps/ios/README.md.
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
