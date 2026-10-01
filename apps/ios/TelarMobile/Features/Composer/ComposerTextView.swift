import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String

    @Binding var focused: Bool
    var fontSize: CGFloat = 16

    var maxLines: Int?

    var listening = false

    var caretRect: Binding<CGRect?>?
    var suggesting = false
    var onSuggestionKey: (ComposerSuggestionKey) -> Void = { _ in }
    var field: ComposerField?
    var onTouch: () -> Void = {}
    let onPaste: ([NSItemProvider]) -> Void

    func makeUIView(context: Context) -> ComposerUITextView {
        let view = ComposerUITextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.isEditable = true
        view.isSelectable = true
        view.isScrollEnabled = true

        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.contentInsetAdjustmentBehavior = .never
        view.showsVerticalScrollIndicator = false
        view.alwaysBounceVertical = false
        view.adjustsFontForContentSizeCategory = true
        view.textColor = UIColor(Theme.text)
        return view
    }

    func updateUIView(_ view: ComposerUITextView, context: Context) {
        context.coordinator.text = $text
        context.coordinator.focused = $focused
        context.coordinator.caretRect = caretRect
        view.onPaste = onPaste
        view.suggesting = suggesting
        view.onSuggestionKey = onSuggestionKey
        view.onTouch = onTouch
        field?.view = view
        field?.coordinator = context.coordinator
        context.coordinator.sync(view, to: text)

        let font = UIFontMetrics.default.scaledFont(for: .systemFont(ofSize: fontSize))
        if view.font != font {
            view.font = font
            view.placeholderLabel.font = font
        }

        view.tintColor = listening ? UIColor(Theme.accent) : nil
        if view.placeholderLabel.text != placeholder {
            view.placeholderLabel.text = placeholder
            view.accessibilityLabel = placeholder
        }
        view.placeholderLabel.isHidden = !text.isEmpty

        context.coordinator.wantsFocus = focused
        DispatchQueue.main.async {
            guard view.window != nil else { return }
            let wants = context.coordinator.wantsFocus
            if wants && !view.isFirstResponder { view.becomeFirstResponder() }
            if !wants && view.isFirstResponder { view.resignFirstResponder() }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerUITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        let line = uiView.font?.lineHeight ?? UIFont.systemFont(ofSize: fontSize).lineHeight
        let content = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let offered = proposal.height.flatMap { $0.isFinite ? $0 : nil } ?? .greatestFiniteMagnitude
        return CGSize(width: width, height: ComposerGrowth.height(content: content, line: line, offered: offered, maxLines: maxLines))
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text, focused: $focused) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var text: Binding<String>
        var focused: Binding<Bool>
        var wantsFocus = false

        var caretRect: Binding<CGRect?>?

        private var published: String?

        private var applying = false

        init(text: Binding<String>, focused: Binding<Bool>) {
            self.text = text
            self.focused = focused
        }

        func sync(_ view: ComposerUITextView, to next: String) {
            guard view.text != next, next != published, view.markedTextRange == nil else { return }
            applying = true
            let moved = view.apply(next)
            applying = false
            guard moved else { return }
            published = view.text

            DispatchQueue.main.async { [weak self, weak view] in
                guard let self, let view else { return }
                report(view)
            }
        }

        func textViewDidChange(_ textView: UITextView) {
            guard !applying else { return }
            publish(textView)
        }

        func publish(_ textView: UITextView) {
            (textView as? ComposerUITextView)?.placeholderLabel.isHidden = !textView.text.isEmpty
            published = textView.text
            if text.wrappedValue != textView.text { text.wrappedValue = textView.text }
            report(textView)
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText: String) -> Bool {
            guard !applying else { return true }
            let inserted = (replacementText as NSString).length
            ComposerLog.shared.record(ComposerLogEntry(
                source: .user,
                location: range.location,
                removed: range.length,
                inserted: inserted,
                length: (textView.text as NSString).length - range.length + inserted,
                marked: textView.markedTextRange != nil
            ))
            return true
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            if !focused.wrappedValue { focused.wrappedValue = true }
            report(textView)
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if focused.wrappedValue { focused.wrappedValue = false }

            if caretRect?.wrappedValue != nil { caretRect?.wrappedValue = nil }
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard !applying else { return }
            report(textView)
        }

        private func report(_ textView: UITextView) {
            guard let caretRect else { return }
            let next = textView.selectedTextRange.map { textView.caretRect(for: $0.end) }

            let usable = next.flatMap { $0.isInfinite || $0.isNull ? nil : $0 }
            if caretRect.wrappedValue != usable { caretRect.wrappedValue = usable }
        }
    }
}

enum ComposerSuggestionKey: Equatable {
    case up, down, accept, dismiss

    static let inputs: [(String, ComposerSuggestionKey)] = [
        (UIKeyCommand.inputUpArrow, .up),
        (UIKeyCommand.inputDownArrow, .down),
        ("\r", .accept),
        ("\t", .accept),
        (UIKeyCommand.inputEscape, .dismiss),
    ]
}

final class ComposerUITextView: UITextView {
    let placeholderLabel = UILabel()
    var onPaste: (([NSItemProvider]) -> Void)?
    var suggesting = false
    var onSuggestionKey: ((ComposerSuggestionKey) -> Void)?

    override var keyCommands: [UIKeyCommand]? {
        guard suggesting else { return super.keyCommands }
        let own = ComposerSuggestionKey.inputs.map { input, _ in
            let command = UIKeyCommand(input: input, modifierFlags: [], action: #selector(suggestionKey(_:)))
            command.wantsPriorityOverSystemBehavior = true
            return command
        }
        return own + (super.keyCommands ?? [])
    }

    @objc private func suggestionKey(_ command: UIKeyCommand) {
        guard let key = ComposerSuggestionKey.inputs.first(where: { $0.0 == command.input })?.1 else { return }
        onSuggestionKey?(key)
    }
    var onTouch: (() -> Void)?

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        placeholderLabel.numberOfLines = 1
        placeholderLabel.lineBreakMode = .byTruncatingTail
        placeholderLabel.textColor = .placeholderText

        placeholderLabel.isAccessibilityElement = false
        addSubview(placeholderLabel)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("never loaded from a nib") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let font = placeholderLabel.font ?? UIFont.preferredFont(forTextStyle: .body)
        placeholderLabel.frame = CGRect(
            x: textContainerInset.left, y: textContainerInset.top,
            width: max(bounds.width - textContainerInset.left - textContainerInset.right, 0),
            height: font.lineHeight
        )
    }

    @discardableResult func apply(_ next: String) -> Bool {
        guard let edit = ComposerTextEdit.replacement(from: text, to: next) else { return false }
        let selection = selectedRange
        let written = edit.range.location + (edit.text as NSString).length
        let caret = ComposerTextEdit.selection(selection, after: edit.range, replacedBy: edit.text)
            ?? NSRange(location: written, length: 0)
        ComposerLog.shared.record(ComposerLogEntry(
            source: .binding,
            location: edit.range.location,
            removed: edit.range.length,
            inserted: (edit.text as NSString).length,
            length: (next as NSString).length
        ))

        inputDelegate?.selectionWillChange(self)
        inputDelegate?.textWillChange(self)
        textStorage.replaceCharacters(in: edit.range, with: NSAttributedString(string: edit.text, attributes: typingAttributes))
        selectedRange = caret
        inputDelegate?.textDidChange(self)
        inputDelegate?.selectionDidChange(self)
        undoManager?.removeAllActions()
        scrollRangeToVisible(caret)

        return true
    }

    func insert(_ text: String, at location: Int) {
        let caret = NSRange(location: location + (text as NSString).length, length: 0)
        inputDelegate?.selectionWillChange(self)
        inputDelegate?.textWillChange(self)
        textStorage.replaceCharacters(in: NSRange(location: location, length: 0), with: NSAttributedString(string: text, attributes: typingAttributes))
        selectedRange = caret
        inputDelegate?.textDidChange(self)
        inputDelegate?.selectionDidChange(self)
        scrollRangeToVisible(caret)
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        onTouch?()
        super.touchesBegan(touches, with: event)
    }

    private var clipboardHasAttachment: Bool {
        ComposerIntake.hasAttachment(in: UIPasteboard.general.types(forItemSet: nil) ?? [])
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), clipboardHasAttachment { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        guard let onPaste, clipboardHasAttachment else { return super.paste(sender) }
        let providers = UIPasteboard.general.itemProviders
            .filter { ComposerIntake.isAttachment($0.registeredTypeIdentifiers) }
        guard !providers.isEmpty else { return super.paste(sender) }
        onPaste(providers)
    }
}
