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

    @Test func anImageOnlyMessageIsTitledByItsPicture() {
        #expect(SessionDraft.title(explicit: "", prompt: " ", imageNames: ["Screenshot.png"]) == "Screenshot.png")
        #expect(SessionDraft.title(explicit: "", prompt: "", imageNames: ["a.png", "b.png"]) == "2 images")
        #expect(SessionDraft.title(explicit: "", prompt: "words win", imageNames: ["a.png"]) == "words win")
    }

    @Test func textAloneCanBeSent() {
        #expect(SessionDraft.canSend(text: "fix it", mediaTypes: []))
        #expect(SessionDraft.canSend(text: "read this", mediaTypes: ["application/pdf"]))
    }

    @Test func anImageAloneCanBeSent() {
        #expect(SessionDraft.canSend(text: "", mediaTypes: ["image/png"]))
        #expect(SessionDraft.canSend(text: "  \n ", mediaTypes: ["application/pdf", "image/jpeg"]))
    }

    @Test func anEmptyBoxOrAFileAloneCannot() {
        #expect(!SessionDraft.canSend(text: "", mediaTypes: []))
        #expect(!SessionDraft.canSend(text: " \n\t ", mediaTypes: []))
        #expect(!SessionDraft.canSend(text: "", mediaTypes: ["application/pdf"]))
    }
}
