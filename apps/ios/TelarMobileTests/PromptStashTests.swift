import Foundation
import Testing
@testable import TelarMobile

/// The web's `prompt-stash.test.ts` rules, on the phone's port: newest
/// first, popped on use, an oversized entry refused before it can evict, and
/// a restore that never eats what is in the box.
@Suite struct PromptStashTests {
    private func entry(_ id: String, _ prompt: String, images: [StashedImage] = [], at: Timestamp = 1) -> StashEntry {
        StashEntry(id: id, at: at, prompt: prompt, images: images)
    }

    @Test func pushIsNewestFirstAndCapped() {
        var list: [StashEntry] = []
        for index in 0..<(StashLimits.entries + 3) { list = StashRules.push(list, entry("e\(index)", "p\(index)")) }
        #expect(list.count == StashLimits.entries)
        #expect(list.first?.id == "e\(StashLimits.entries + 2)")
        #expect(!list.contains { $0.id == "e0" })
    }

    @Test func anOversizedEntryIsRefusedBeforeItEvictsAnything() {
        let huge = entry("huge", "", images: [StashedImage(name: "a.png", type: "image/png", dataUrl: String(repeating: "x", count: StashLimits.entryChars + 1))])
        let fitted = StashRules.fit([huge, entry("a", "keep"), entry("b", "keep too")])
        #expect(fitted.map(\.id) == ["a", "b"])
    }

    @Test func takePopsAndLeavesAnImageOnlyRemainderWhenTheBoxIsFull() {
        let images = (0..<3).map { StashedImage(name: "\($0).png", type: "image/png", dataUrl: "d\($0)") }
        let list = [entry("e", "hello", images: images)]
        let full = StashRules.take(list, "e", room: 8)!
        #expect(full.prompt == "hello" && full.images.count == 3 && full.left == 0 && full.next.isEmpty)
        let cramped = StashRules.take(list, "e", room: 1)!
        #expect(cramped.images.count == 1 && cramped.left == 2)
        #expect(cramped.next.first?.prompt == "" && cramped.next.first?.images.count == 2)
        #expect(StashRules.take(list, "missing", room: 8) == nil)
    }

    @Test func appendNeverEatsTheDraft() {
        #expect(StashRules.appendPrompt("", "stashed") == "stashed")
        #expect(StashRules.appendPrompt("typing  \n", "stashed") == "typing\n\nstashed")
        #expect(StashRules.appendPrompt("typing", "") == "typing")
    }

    @Test func summaryIsTheFirstNonEmptyLine() {
        #expect(entry("a", "\n\n  Second line is first\nmore").summary == "Second line is first")
        #expect(entry("b", "", images: [StashedImage(name: "x", type: "image/png", dataUrl: "d")]).summary == "1 image")
        #expect(entry("c", "").summary == "Empty")
        #expect(entry("d", String(repeating: "a", count: 120)).summary.count == 90)
    }

    @Test @MainActor func theStoreRoundTripsThroughDefaults() {
        let suite = "telar.stash.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let stash = PromptStash(defaults: defaults)
        #expect(stash.stash(entry("one", "first")))
        #expect(stash.stash(entry("two", "second")))
        #expect(PromptStash(defaults: defaults).entries.map(\.id) == ["two", "one"])
        let taken = stash.take("two", room: 8)
        #expect(taken?.prompt == "second")
        #expect(stash.entries.map(\.id) == ["one"])
        stash.drop("one")
        #expect(stash.entries.isEmpty)
    }

    @Test func agoIsCoarse() {
        let now = Date(timeIntervalSince1970: 10_000)
        #expect(stashAgo(Timestamp(9_990 * 1000), now: now) == "just now")
        #expect(stashAgo(Timestamp(9_000 * 1000), now: now) == "16m ago")
        #expect(stashAgo(Timestamp(0), now: now) == "2h ago")
    }
}
