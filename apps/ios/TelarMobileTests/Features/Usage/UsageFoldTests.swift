import Foundation
import Testing
@testable import TelarMobile

@Suite struct UsageFoldTests {
    private let wire = """
    {"usage":{
      "sinceMs":1000,"untilMs":2000,"resolution":"day","timeZone":"Europe/Madrid",
      "buckets":[
        {"period":"2026-09-11","driver":"claude","model":"claude-opus-5",
         "tokens":{"input":100,"output":50,"cacheRead":800,"cacheCreate":50},
         "costUsd":1.5,"priced":true,"turns":4},
        {"period":"2026-09-12","driver":"claude","model":"claude-sonnet-5",
         "tokens":{"input":10,"output":5,"cacheRead":0,"cacheCreate":0,"reasoning":3},
         "costUsd":0.25,"priced":false,"turns":1},
        {"period":"2026-09-12","driver":"codex","model":"gpt-5",
         "tokens":{"input":200,"output":100,"cacheRead":0,"cacheCreate":0},
         "costUsd":0,"priced":false,"turns":2}
      ],
      "sources":[
        {"provider":"claude","status":"ok","path":"/Users/x/.claude/projects","files":12,"sessions":3},
        {"provider":"codex","status":"missing","path":"/Users/x/.codex/sessions","files":0,"sessions":0}
      ],
      "pricing":"fresh","sessions":3,"readAt":2000
    }}
    """

    private func decoded() throws -> UsageReport {
        struct Wrapped: Decodable { var usage: UsageReport }
        return try JSONDecoder().decode(Wrapped.self, from: Data(wire.utf8)).usage
    }

    @Test func decodesTheWireShapeIncludingAnUninstalledSource() throws {
        let report = try decoded()
        #expect(report.resolution == "day")
        #expect(report.timeZone == "Europe/Madrid")
        #expect(report.buckets.count == 3)
        #expect(report.buckets[1].tokens.reasoning == 3)
        #expect(report.sources.last?.status == "missing")
        #expect(report.pricing == "fresh")
    }

    @Test func totalsSumEveryBucketAndCarryThePricedFlagDown() throws {
        let fold = foldUsage(try decoded())

        #expect(fold.total.processed == 1315)
        #expect(fold.total.tokens.input == 310)
        #expect(fold.total.tokens.cacheRead == 800)
        #expect(fold.total.turns == 7)
        #expect(abs(fold.total.costUsd - 1.75) < 0.0001)

        #expect(fold.total.priced == false)
        #expect(fold.sessions == 3)
    }

    @Test func sharesAreOfProcessedTokens() throws {
        let fold = foldUsage(try decoded())
        #expect(fold.providers.map(\.driver) == ["claude", "codex"])
        let claude = try #require(fold.providers.first)

        #expect(claude.totals.processed == 1015)
        #expect(abs(claude.share - 1015.0 / 1315.0) < 0.0001)
        #expect(abs(fold.providers[1].share - 300.0 / 1315.0) < 0.0001)

        #expect(formatShare(claude.share) == "77.2%")
    }

    @Test func aProviderWithNothingInTheWindowIsNotARow() throws {
        var report = try decoded()
        report.buckets = report.buckets.filter { $0.driver == "claude" }
        let fold = foldUsage(report)
        #expect(fold.providers.map(\.driver) == ["claude"])
    }

    @Test func anUnknownDriverKeepsItsRowAfterTheKnownOnes() throws {
        var report = try decoded()
        report.buckets.append(UsageBucket(period: "2026-09-12", driver: "gemini", model: "g",
                                          tokens: TokenUsage(input: 7, output: 0, cacheRead: 0, cacheCreate: 0),
                                          costUsd: 0, priced: true, turns: 1))
        let fold = foldUsage(report)
        #expect(fold.providers.map(\.driver) == ["claude", "codex", "gemini"])
        #expect(usageDriverLabel("gemini") == "gemini")
    }

    @Test func anEmptyWindowFoldsToNothingRatherThanDividingByZero() {
        let fold = foldUsage(.empty)
        #expect(fold.providers.isEmpty)
        #expect(fold.total.processed == 0)
        #expect(fold.total.turns == 0)

        #expect(fold.total.priced == true)
    }

    @Test func tokenFiguresMatchTheWebsFormatter() {
        #expect(formatTokens(0) == "0")
        #expect(formatTokens(999) == "999")
        #expect(formatTokens(1_000) == "1.00K")
        #expect(formatTokens(12_345) == "12.3K")
        #expect(formatTokens(1_000_000) == "1.00M")
        #expect(formatTokens(4_560_000) == "4.56M")
        #expect(formatTokens(123_000_000) == "123M")
        #expect(formatTokens(2_500_000_000) == "2.50B")
    }

    @Test func costIsAlwaysTwoDecimals() {
        #expect(formatUsd(0) == "$0.00")
        #expect(formatUsd(1.5) == "$1.50")
        #expect(formatUsd(12.345) == "$12.35")
    }
}
