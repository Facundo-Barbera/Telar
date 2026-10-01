import SwiftUI
import Testing
import UIKit
@testable import TelarMobile

@MainActor @Suite struct ComposerFieldTests {
    private struct Configuration: Equatable {
        var text: String
        var selection: NSRange
        var delegateIsCoordinator: Bool
        var editable: Bool
        var autocorrection: UITextAutocorrectionType
        var spellChecking: UITextSpellCheckingType
        var keyboard: UIKeyboardType
        var attributeRuns: Int
        var markedText: Bool
        var gestures: Int
        var interactions: Int
    }

    private final class Draft {
        var text = ""
    }

    private func mount(_ text: String = "") -> (ComposerUITextView, ComposerTextView.Coordinator, ComposerField, Draft) {
        let draft = Draft()
        draft.text = text
        let binding = Binding(get: { draft.text }, set: { draft.text = $0 })
        let coordinator = ComposerTextView.Coordinator(text: binding, focused: .constant(true))
        let view = ComposerUITextView()
        view.delegate = coordinator
        view.font = .systemFont(ofSize: 16)
        coordinator.sync(view, to: text)
        let field = ComposerField()
        field.view = view
        field.coordinator = coordinator
        return (view, coordinator, field, draft)
    }

    private func configuration(_ view: ComposerUITextView, _ coordinator: ComposerTextView.Coordinator) -> Configuration {
        var runs = 0
        view.textStorage.enumerateAttributes(in: NSRange(location: 0, length: view.textStorage.length)) { _, _, _ in runs += 1 }
        return Configuration(
            text: view.text,
            selection: view.selectedRange,
            delegateIsCoordinator: view.delegate === coordinator,
            editable: view.isEditable,
            autocorrection: view.autocorrectionType,
            spellChecking: view.spellCheckingType,
            keyboard: view.keyboardType,
            attributeRuns: runs,
            markedText: view.markedTextRange != nil,
            gestures: view.gestureRecognizers?.count ?? 0,
            interactions: view.interactions.count
        )
    }

    @Test func afterACommitTheFieldIsConfiguredLikeAFreshOne() {
        let (view, coordinator, field, draft) = mount("fix test")
        view.selectedRange = NSRange(location: 4, length: 0)
        #expect(field.commit("the failing"))
        #expect(draft.text == "fix the failing test")

        let (fresh, freshCoordinator, _, _) = mount("fix the failing test")
        fresh.selectedRange = view.selectedRange
        #expect(configuration(view, coordinator) == configuration(fresh, freshCoordinator))
    }

    @Test func typingAfterACommitReachesTheDraftUnchanged() {
        let (view, coordinator, field, draft) = mount("")
        #expect(field.commit("hello"))
        view.selectedRange = NSRange(location: 5, length: 0)
        view.insertText("!")
        coordinator.textViewDidChange(view)
        #expect(draft.text == "hello!")
        view.deleteBackward()
        coordinator.textViewDidChange(view)
        #expect(draft.text == "hello")
        coordinator.sync(view, to: draft.text)
        #expect(view.text == "hello")
    }

    @Test func aSelectionIsNeverOverwrittenByACommit() {
        let (view, _, field, draft) = mount("keep this")
        view.selectedRange = NSRange(location: 0, length: 4)
        #expect(field.commit("spoken"))
        #expect(draft.text == "keep spoken this")
    }

    @Test func anUnmountedFieldRefusesSoTheWordsAreNotLost() {
        let field = ComposerField()
        #expect(field.commit("lost?") == false)
        #expect(field.isMounted == false)
    }

    @Test func handingTheAudioSessionBackRestoresItsCategory() throws {
        let before = AudioSessionClaim.describe()
        let claim = AudioSessionClaim()
        try claim.take()
        #expect(AudioSessionClaim.describe() != before)
        claim.handBack()
        #expect(AudioSessionClaim.describe() == before)
    }
}
