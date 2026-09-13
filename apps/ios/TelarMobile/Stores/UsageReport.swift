import Foundation

/// SPEND OVER TIME — the wire shape `GET /api/usage` answers with, and the fold
/// the screen renders. Mirrors `UsageReport` in
/// packages/engine-client/src/protocol/common.ts and `foldUsage` in
/// apps/web/lib/usage-report.ts.
///
/// THE REPORT IS ONE MAC'S. It is derived by scanning that machine's provider
/// transcripts (`~/.claude/projects`, `~/.codex/sessions`), so there is no such
/// thing as a merged figure across paired Macs: two of them are two ledgers of
/// two machines' work, and adding them would answer a question nobody asked.
/// The screen picks a Mac; it never sums.
///
/// COST IS THE PROVIDER'S FIGURE where the transcript carries one and the rate
/// table's otherwise. A model neither knows stays UNPRICED: its tokens count and
/// its cost reads as absent, never as $0.00 — a zero would claim the work was
/// free.
extension TokenUsage {
    static let zero = TokenUsage(input: 0, output: 0, cacheRead: 0, cacheCreate: 0)

    /// Every token the window moved — the screen's headline figure, and the
    /// web's `processedTokens`. `reasoning` is deliberately absent from the sum:
    /// the providers that report it also count it inside `output`, so adding it
    /// would count those tokens twice.
    var processed: Int { input + output + cacheRead + cacheCreate }
}

struct UsageBucket: Decodable, Equatable {
    /// `YYYY-MM-DD` in the requested zone for days; the hour-start epoch ms as a
    /// decimal string for hours.
    var period: String
    var driver: String
    var model: String
    var tokens: TokenUsage
    var costUsd: Double
    /// Whether every record here has a cost — provider-reported or rate-priced.
    var priced: Bool
    /// Records, not turns: one Claude assistant message or one Codex token
    /// count. The screen says "requests" for this reason.
    var turns: Int
}

/// One transcript directory's scan outcome, so the screen can say what was and
/// was not counted rather than letting a missing install read as zero use.
struct UsageSource: Decodable, Equatable {
    var provider: String
    /// ok | missing | failed.
    var status: String
    var path: String
    var files: Int
    var sessions: Int
}

struct UsageReport: Decodable, Equatable {
    var sinceMs: Timestamp
    var untilMs: Timestamp
    /// day | hour.
    var resolution: String
    var timeZone: String
    var buckets: [UsageBucket]
    var sources: [UsageSource]
    /// fresh | cached | unavailable — where rate-priced costs came from.
    var pricing: String
    var sessions: Int
    var readAt: Timestamp

    static let empty = UsageReport(sinceMs: 0, untilMs: 0, resolution: "day", timeZone: "UTC",
                                   buckets: [], sources: [], pricing: "unavailable", sessions: 0, readAt: 0)
}

// MARK: - the fold

/// One slice's totals — the web's `UsageTotals`.
struct UsageTotals: Equatable {
    var tokens = TokenUsage.zero
    var processed = 0
    var costUsd: Double = 0
    /// True when every counted record carried a cost figure.
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
    /// This provider's share of PROCESSED TOKENS — never of cost. Cost is absent
    /// for a whole provider (Codex reports none), and a share of a figure
    /// missing half its terms would always read 100% Claude. The web's rule.
    var share: Double
    var id: String { driver }
}

struct UsageFold: Equatable {
    var total = UsageTotals()
    var providers: [UsageProviderSlice] = []
    var sessions = 0
}

/// THE DRIVERS, IN THE ORDER THE WEB LISTS THEM, and their labels — the phone
/// and the Mac name the same provider the same way.
let usageDrivers = ["claude", "codex", "opencode"]

func usageDriverLabel(_ driver: String) -> String {
    switch driver {
    case "claude": "Claude"
    case "codex": "Codex"
    case "opencode": "OpenCode"
    // A provider this build predates is named by its own id rather than
    // dropped: an unlabelled row still carries real spend.
    default: driver
    }
}

/// The screen's one derivation — `foldUsage`, minus the per-period and per-model
/// slices the phone's screen does not draw (there is no chart and no breakdown
/// table here, by #404's own scope). Pure, and tested.
///
/// A PROVIDER WITH NOTHING IN THE WINDOW IS NOT A ROW. The web's rule: a Codex
/// line reading 0% / $0.00 on a week nobody ran Codex is a fact about the
/// provider list, not about the window.
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
    // The enumerated drivers first, in their own order, then anything the wire
    // named that this build does not know — so a newer provider shows up rather
    // than vanishing into a total nothing accounts for.
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

// MARK: - formatting

func formatUsd(_ value: Double) -> String { String(format: "$%.2f", value) }

/// Compact token figure — `12.3K`, `4.56M`, `1.00M`. Three significant figures,
/// the web's `formatTokens` unit for unit and rounding for rounding, so the two
/// screens print the same number the same way.
///
/// `toPrecision(3)` SPELLED OUT rather than `%.3g`, which drops the trailing
/// zeroes JavaScript keeps: a million tokens is `1.00M` on the Mac and would
/// have been `1M` here. The scaled value is always in [1, 1000) — the next unit
/// up claims anything larger — so the decimal count is just 3 minus its digits.
///
/// ONE SEAM, AT THE TOP OF EACH UNIT: a figure that rounds UP to 1000 in its own
/// unit (999,999 tokens) is `1000K` here and `1.00e+3K` on the web, because
/// `toPrecision` switches to exponential once the exponent reaches the
/// precision. Four digits is the better of the two answers and the seam is one
/// value wide per unit, so it is left alone rather than reproduced.
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
