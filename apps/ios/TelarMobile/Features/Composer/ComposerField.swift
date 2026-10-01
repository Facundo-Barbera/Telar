import UIKit

@MainActor final class ComposerField {
    weak var view: ComposerUITextView?
    weak var coordinator: ComposerTextView.Coordinator?

    var isMounted: Bool { view != nil }

    func location(in draft: String) -> Int? {
        guard let view, view.isFirstResponder, view.text == draft else { return nil }
        return view.selectedRange.location
    }

    func commit(_ phrase: String, finishing: Bool = false) -> Bool {
        guard let view else { return false }
        if view.markedTextRange != nil {
            guard finishing else { return false }
            view.unmarkText()
        }
        let at = NSRange(location: min(NSMaxRange(view.selectedRange), view.textStorage.length), length: 0)
        let insert = ComposerTextEdit.spaced(phrase, in: view.text, at: at)
        let inserted = (insert as NSString).length
        ComposerLog.shared.record(ComposerLogEntry(
            source: .commit,
            location: at.location,
            inserted: inserted,
            length: (view.text as NSString).length + inserted
        ))
        view.insert(insert, at: at.location)
        coordinator?.publish(view)
        return true
    }
}
