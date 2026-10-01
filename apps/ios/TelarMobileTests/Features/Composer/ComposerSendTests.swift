import Testing
@testable import TelarMobile

@MainActor @Suite struct ComposerSendTests {
    @MainActor private final class Composer {
        var draft = ""
        var sent: [String] = []
        var finalWords: CheckedContinuation<Void, Never>?

        func take() -> String? {
            guard !draft.isEmpty else { return nil }
            defer { draft = "" }
            return draft
        }

        func finishDictation() async {
            await withCheckedContinuation { finalWords = $0 }
            draft = DictationStrip.appending("and the last words", to: draft)
        }
    }

    @Test func sendWaitsForTheFinalTranscriptAndSendsEverythingOnce() async {
        let composer = Composer()
        let sender = ComposerSend()
        composer.draft = "typed first"

        let first = Task {
            await sender.run(finishing: composer.finishDictation, take: composer.take) { composer.sent.append($0) }
        }
        while composer.finalWords == nil { await Task.yield() }
        #expect(sender.busy)
        await sender.run(finishing: composer.finishDictation, take: composer.take) { composer.sent.append($0) }
        #expect(composer.sent.isEmpty)

        composer.finalWords?.resume()
        await first.value
        #expect(composer.sent == ["typed first and the last words"])
        #expect(composer.draft.isEmpty)
        #expect(!sender.busy)
    }

    @Test func withoutDictationItSendsTheDraftAtOnce() async {
        let composer = Composer()
        let sender = ComposerSend()
        composer.draft = "hello"
        await sender.run(finishing: nil, take: composer.take) { composer.sent.append($0) }
        #expect(composer.sent == ["hello"])
        #expect(composer.draft.isEmpty)
    }
}
