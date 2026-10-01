import SwiftUI
import Testing
import UIKit
@testable import TelarMobile

@MainActor @Suite struct ComposerTextViewTests {
    private final class Draft {
        var text = ""
    }

    private struct Mounted {
        let view: ComposerUITextView
        let coordinator: ComposerTextView.Coordinator
        let field: ComposerField
        let draft: Draft
        let window: UIWindow
    }

    private func mount() -> Mounted {
        let draft = Draft()
        let binding = Binding(get: { draft.text }, set: { draft.text = $0 })
        let coordinator = ComposerTextView.Coordinator(text: binding, focused: .constant(true))
        let view = ComposerUITextView()
        view.delegate = coordinator
        view.font = .systemFont(ofSize: 16)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 200))
        window.addSubview(view)
        let field = ComposerField()
        field.view = view
        field.coordinator = coordinator
        return Mounted(view: view, coordinator: coordinator, field: field, draft: draft, window: window)
    }

    private func type(_ text: String, into mounted: Mounted) {
        mounted.view.insertText(text)
        mounted.coordinator.textViewDidChange(mounted.view)
    }

    private func backspace(_ mounted: Mounted) {
        mounted.view.deleteBackward()
        mounted.coordinator.textViewDidChange(mounted.view)
    }

    private func nextTurn() async {
        await withCheckedContinuation { done in DispatchQueue.main.async { done.resume() } }
    }

    @Test func rapidKeystrokesSurviveStaleBindingSnapshots() async {
        let mounted = mount()
        var snapshots: [String] = []
        for letter in ["h", "e", "l", "l", "o"] {
            snapshots.append(mounted.draft.text)
            type(letter, into: mounted)
        }
        for stale in snapshots { mounted.coordinator.sync(mounted.view, to: stale) }
        #expect(mounted.view.text == "hello")
        await nextTurn()
        #expect(mounted.view.text == "hello")
        #expect(mounted.draft.text == "hello")
    }

    @Test func aBackspaceIsNotUndoneByTheValueBeforeIt() async {
        let mounted = mount()
        type("cat", into: mounted)
        let before = mounted.draft.text
        backspace(mounted)
        mounted.coordinator.sync(mounted.view, to: before)
        await nextTurn()
        #expect(mounted.view.text == "ca")
        #expect(mounted.draft.text == "ca")
    }

    @Test func dictationArrivingMidTypingKeepsEveryTypedLetter() async {
        let mounted = mount()
        type("fix ", into: mounted)
        let snapshot = mounted.draft.text
        #expect(mounted.field.commit("the bug"))
        type(" now", into: mounted)
        mounted.coordinator.sync(mounted.view, to: snapshot)
        await nextTurn()
        #expect(mounted.view.text == "fix the bug now")
        #expect(mounted.draft.text == "fix the bug now")
    }

    @Test func aWriteFromOutsideStillReachesAFocusedField() async {
        let mounted = mount()
        type("send me", into: mounted)
        mounted.draft.text = ""
        mounted.coordinator.sync(mounted.view, to: "")
        await nextTurn()
        #expect(mounted.view.text == "")

        mounted.draft.text = "/review "
        mounted.coordinator.sync(mounted.view, to: "/review ")
        await nextTurn()
        #expect(mounted.view.text == "/review ")
    }
}
