import SwiftUI
import Testing
import UIKit
@testable import TelarMobile

@MainActor @Suite struct ComposerTextViewTests {
    private final class Draft {
        var text = ""
    }

    private func field() -> (ComposerUITextView, ComposerTextView.Coordinator, Draft) {
        let draft = Draft()
        let binding = Binding(get: { draft.text }, set: { draft.text = $0 })
        let coordinator = ComposerTextView.Coordinator(text: binding, focused: .constant(true))
        let view = ComposerUITextView()
        view.delegate = coordinator
        return (view, coordinator, draft)
    }

    private func type(_ text: String, in view: ComposerUITextView, _ coordinator: ComposerTextView.Coordinator) {
        view.text = text
        coordinator.textViewDidChange(view)
    }

    @Test func aDictatedDraftClearedOnSendClearsTheField() {
        let (view, coordinator, _) = field()
        type("x", in: view, coordinator)
        type("", in: view, coordinator)

        coordinator.sync(view, to: "hello there")
        #expect(view.text == "hello there")

        coordinator.sync(view, to: "")
        #expect(view.text == "")
    }

    @Test func typingAfterDictationStopsReachesTheDraftAndIsNotRewritten() {
        let (view, coordinator, draft) = field()
        coordinator.listening = true
        coordinator.sync(view, to: "fix the bug")
        coordinator.listening = false
        coordinator.settle(view)

        type("fix the bugs", in: view, coordinator)
        #expect(draft.text == "fix the bugs")
        coordinator.sync(view, to: draft.text)
        #expect(view.text == "fix the bugs")

        type("fix the bug", in: view, coordinator)
        coordinator.sync(view, to: draft.text)
        #expect(view.text == "fix the bug")
        #expect(draft.text == "fix the bug")
    }

    @Test func aProgrammaticEditLeavesNothingToUndo() {
        let (view, coordinator, _) = field()
        coordinator.sync(view, to: "said out loud")
        #expect(view.undoManager?.canUndo != true)
    }

    @Test func aCaretBeforeAnInsertedPhraseStaysPut() {
        let (view, coordinator, _) = field()
        type("fix test", in: view, coordinator)
        view.selectedRange = NSRange(location: 2, length: 0)
        coordinator.sync(view, to: "fix the test")
        #expect(view.selectedRange == NSRange(location: 2, length: 0))
    }
}
