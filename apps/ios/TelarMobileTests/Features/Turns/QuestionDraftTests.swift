import Foundation
import Testing
@testable import TelarMobile

@Suite struct QuestionDraftTests {
    private let color = UserInputField(
        key: "color", label: "Which color?", kind: "choice", choices: ["Red", "Blue"], required: true,
        header: "Color", descriptions: ["Red": "warm"]
    )
    private let toppings = UserInputField(
        key: "toppings", label: "Which toppings?", kind: "choice", choices: ["Olives", "Basil", "Chili"],
        required: true, multiple: true
    )

    @Test func aSecretOrAToggleKeepsThePlainForm() {
        #expect(QuestionDraft(fields: []) == nil)
        #expect(QuestionDraft(fields: [color, UserInputField(key: "pw", label: "Password", kind: "secret")]) == nil)
        #expect(QuestionDraft(fields: [color, UserInputField(key: "ok", label: "OK?", kind: "boolean")]) == nil)
    }

    @Test func eachQuestionIsAPageWithItsHeaderAndDescriptions() throws {
        let draft = try #require(QuestionDraft(fields: [color, toppings]))
        #expect(draft.pages.count == 2)
        #expect(draft.page.header == "Color")
        #expect(draft.page.descriptions == ["Red": "warm"])
        #expect(draft.pages[1].multiple)
    }

    @Test func nextWaitsForAnAnswerAndSubmitForAll() throws {
        var draft = try #require(QuestionDraft(fields: [color, toppings]))
        #expect(!draft.canAdvance)
        draft.advance()
        #expect(draft.index == 0)
        draft.toggle("Blue")
        #expect(draft.canAdvance)
        #expect(draft.answers == nil)
        draft.advance()
        #expect(draft.index == 1)
        #expect(draft.isLast)
        draft.back()
        #expect(draft.index == 0)
        #expect(draft.isSelected("Blue"))
    }

    @Test func singleSelectReplacesAndTogglesOff() throws {
        var draft = try #require(QuestionDraft(fields: [color]))
        draft.toggle("Red")
        draft.toggle("Blue")
        #expect(!draft.isSelected("Red"))
        #expect(draft.answers == ["color": .text("Blue")])
        draft.toggle("Blue")
        #expect(draft.answers == nil)
    }

    @Test func multiSelectSendsPicksInChoiceOrder() throws {
        var draft = try #require(QuestionDraft(fields: [toppings]))
        draft.toggle("Chili")
        draft.toggle("Olives")
        #expect(draft.answers == ["toppings": .list(["Olives", "Chili"])])
        draft.toggle("Chili")
        #expect(draft.answers == ["toppings": .list(["Olives"])])
    }

    @Test func anOtherAnswerReplacesTheChoiceAndAChoiceClearsIt() throws {
        var draft = try #require(QuestionDraft(fields: [color, toppings]))
        draft.toggle("Red")
        draft.setCustom("  Green ")
        #expect(!draft.isSelected("Red"))
        draft.advance()
        draft.setCustom("Anchovies")
        #expect(draft.answers == ["color": .text("Green"), "toppings": .list(["Anchovies"])])
        draft.toggle("Basil")
        #expect(draft.customText == "")
        #expect(draft.answers == ["color": .text("Green"), "toppings": .list(["Basil"])])
    }

    @Test func aTextQuestionIsAnsweredByTyping() throws {
        var draft = try #require(QuestionDraft(fields: [UserInputField(key: "name", label: "Name?", kind: "text")]))
        #expect(!draft.canAdvance)
        draft.setCustom("   ")
        #expect(!draft.canAdvance)
        draft.setCustom("Telar")
        #expect(draft.answers == ["name": .text("Telar")])
    }
}
