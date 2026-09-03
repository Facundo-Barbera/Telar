import Foundation
import Testing
@testable import TelarMobile

/// Port of the web's "a live turn folds as it works" suite.
@Suite struct ActivitySegmentsTests {
    private func row(_ id: String, _ type: String) -> JournalItem {
        JournalItem(item: makeItem(id, type: type), streamedText: "", openedBy: 0)
    }

    @Test func runsAreCutAtProseSteersPlansAndCompactions() {
        // THE BUG THIS PINS: one window over everything before the last
        // narration, then every tool call after it stacked flat until the
        // turn ended. Each run is its own group; only the last is live.
        let segments = segmentActivity([
            row("a", "command_execution"), row("b", "file_read"),
            row("c", "assistant_message"), row("d", "command_execution"),
            row("e", "user_message"), row("f", "plan"),
            row("g", "context_compaction"), row("h", "file_change"),
        ])
        let shape = segments.map { segment -> String in
            switch segment {
            case .row(let item): item.id
            case .run(let items): items.map(\.id).joined()
            }
        }
        #expect(shape == ["ab", "c", "d", "e", "f", "g", "h"])
    }

    @Test func reasoningAndSpawnsStayInsideTheirRun() {
        let segments = segmentActivity([row("a", "reasoning"), row("b", "task"), row("c", "command_execution")])
        #expect(segments.count == 1)
        if case .run(let items) = segments[0] { #expect(items.count == 3) } else { Issue.record("expected a run") }
    }

    @Test func emptyTimelineHasNoSegments() {
        #expect(segmentActivity([]).isEmpty)
    }
}
