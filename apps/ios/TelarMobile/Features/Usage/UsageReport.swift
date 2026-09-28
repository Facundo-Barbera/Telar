import Foundation

extension TokenUsage {
    static let zero = TokenUsage(input: 0, output: 0, cacheRead: 0, cacheCreate: 0)

    var processed: Int { input + output + cacheRead + cacheCreate }
}

struct UsageBucket: Decodable, Equatable {
    var period: String
    var driver: String
    var model: String
    var tokens: TokenUsage
    var costUsd: Double

    var priced: Bool

    var turns: Int
}

struct UsageSource: Decodable, Equatable {
    var provider: String

    var status: String
    var path: String
    var files: Int
    var sessions: Int
}

struct UsageReport: Decodable, Equatable {
    var sinceMs: Timestamp
    var untilMs: Timestamp

    var resolution: String
    var timeZone: String
    var buckets: [UsageBucket]
    var sources: [UsageSource]

    var pricing: String
    var sessions: Int
    var readAt: Timestamp

    static let empty = UsageReport(sinceMs: 0, untilMs: 0, resolution: "day", timeZone: "UTC",
                                   buckets: [], sources: [], pricing: "unavailable", sessions: 0, readAt: 0)
}

struct UsageTotals: Equatable {
    var tokens = TokenUsage.zero
    var processed = 0
    var costUsd: Double = 0

    var priced = true
    var turns = 0

    mutating func fold(_ bucket: UsageBucket) {
        tokens.input += bucket.tokens.input
        tokens.output += bucket.tokens.output
        tokens.cacheRead += bucket.tokens.cacheRead
        tokens.cacheCreate += bucket.tokens.cacheCreate
        processed += bucket.tokens.processed
        costUsd += bucket.costUsd
        priced = priced && bucket.priced
        turns += bucket.turns
    }
}

struct UsageProviderSlice: Identifiable, Equatable {
    var driver: String
    var totals: UsageTotals

    var share: Double
    var id: String { driver }
}

struct UsageFold: Equatable {
    var total = UsageTotals()
    var providers: [UsageProviderSlice] = []
    var sessions = 0
}

let usageDrivers = ["claude", "codex", "opencode", "telar"]

func usageDriverLabel(_ driver: String) -> String {
    switch driver {
    case "claude": "Claude"
    case "codex": "Codex"
    case "opencode": "OpenCode"
    case "telar": "Telar"

    default: driver
    }
}

func foldUsage(_ report: UsageReport) -> UsageFold {
    var total = UsageTotals()
    var byProvider: [String: UsageTotals] = [:]
    for bucket in report.buckets {
        total.fold(bucket)
        byProvider[bucket.driver, default: UsageTotals()].fold(bucket)
    }
    let share = { (slice: UsageTotals) -> Double in
        total.processed > 0 ? Double(slice.processed) / Double(total.processed) : 0
    }

    let known = usageDrivers.filter { byProvider[$0] != nil }
    let rest = byProvider.keys.filter { !usageDrivers.contains($0) }.sorted()
    return UsageFold(
        total: total,
        providers: (known + rest).compactMap { driver in
            guard let slice = byProvider[driver], slice.processed > 0 || slice.turns > 0 else { return nil }
            return UsageProviderSlice(driver: driver, totals: slice, share: share(slice))
        },
        sessions: report.sessions
    )
}

func formatUsd(_ value: Double) -> String { String(format: "$%.2f", value) }

func formatTokens(_ value: Int) -> String {
    if value < 1_000 { return String(value) }
    for (scale, suffix) in [(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")] where Double(value) >= scale {
        let scaled = Double(value) / scale
        let decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0
        return "\(String(format: "%.\(decimals)f", scaled))\(suffix)"
    }
    return String(value)
}

func formatShare(_ value: Double) -> String { String(format: "%.1f%%", value * 100) }
