import Testing
@testable import TelarMobile

@Suite struct SessionDraftTests {
    @Test func derivedTitleCollapsesWhitespaceLikeTheWebCanvas() {
        #expect(SessionDraft.title(explicit: "", prompt: "fix   the\n\nlogin   bug") == "fix the login bug")
    }

    @Test func derivedTitleCapsAtEightyCharacters() {
        let long = String(repeating: "a", count: 200)
        #expect(SessionDraft.title(explicit: "", prompt: long).count == 80)
    }

    @Test func explicitTitleWins() {
        #expect(SessionDraft.title(explicit: "  Auth refactor  ", prompt: "do things") == "Auth refactor")
    }

    @Test func allWhitespaceExplicitTitleFallsBackToThePrompt() {
        #expect(SessionDraft.title(explicit: "   \n ", prompt: "hello world") == "hello world")
    }
}
