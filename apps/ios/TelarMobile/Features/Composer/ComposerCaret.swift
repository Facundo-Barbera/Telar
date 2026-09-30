import UIKit

@MainActor final class ComposerCaret {
    weak var view: UITextView?

    func location(in draft: String) -> Int? {
        guard let view, view.isFirstResponder, view.text == draft else { return nil }
        return view.selectedRange.location
    }
}
