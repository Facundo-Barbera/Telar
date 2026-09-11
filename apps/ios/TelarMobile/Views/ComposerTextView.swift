import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// THE COMPOSER'S FIELD, IN UIKit, so that the system's own Paste can put a
/// picture in the box.
///
/// SwiftUI's `TextField` takes text and nothing else, and that is not a
/// cosmetic limit: iOS builds the long-press menu by asking the FIRST
/// RESPONDER what it can accept, so with only a screenshot on the clipboard a
/// text field answers no and the Paste item is not drawn at all. That missing
/// menu item is the bug — there was nothing to tap, so the only way in was the
/// composer's own paste control. Nothing outside the field can change that
/// answer: the field has to be ours.
///
/// NOT THE SwiftUI MODIFIERS. `.onPasteCommand` and `.pasteDestination` are
/// `iOS 27.0+` in the SDK (macOS has had them since 11 and 13), and this app
/// runs from iOS 18 — so on every phone that has the problem they do not
/// exist. They also hang off a SURROUNDING view rather than the field, which
/// is the wrong end of the responder chain for the menu being discussed.
struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    /// The first-responder state, mirrored BOTH WAYS: SwiftUI writes it to
    /// raise or dismiss the keyboard (the transcript's tap-to-dismiss does
    /// exactly that), and the field writes it back whenever the system moves
    /// focus on its own.
    @Binding var focused: Bool
    var fontSize: CGFloat = 16
    /// How far the box grows before it starts scrolling. `nil` takes whatever
    /// height the layout proposes — the new-session sheet's whole page.
    var maxLines: Int?
    let onPaste: ([NSItemProvider]) -> Void

    func makeUIView(context: Context) -> ComposerUITextView {
        let view = ComposerUITextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.isEditable = true
        view.isSelectable = true
        view.isScrollEnabled = true
        // Flush with the leading edge, the way a SwiftUI field is, so the
        // composer's own padding is the only padding in the pill.
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
        view.onPaste = onPaste
        if view.text != text { view.text = text }

        let font = UIFontMetrics.default.scaledFont(for: .systemFont(ofSize: fontSize))
        if view.font != font {
            view.font = font
            view.placeholderLabel.font = font
        }
        if view.placeholderLabel.text != placeholder {
            view.placeholderLabel.text = placeholder
            view.accessibilityLabel = placeholder
        }
        view.placeholderLabel.isHidden = !text.isEmpty
        // A collapsed pill shows one line, and it must be the FIRST one: a
        // field left scrolled to its tail would show the middle of a draft.
        if !focused && view.contentOffset.y != 0 { view.setContentOffset(.zero, animated: false) }

        // Raising or dismissing the keyboard is a UIKit side effect, and
        // `becomeFirstResponder` reports back through the delegate — doing it
        // here would write state in the middle of SwiftUI's update pass.
        context.coordinator.wantsFocus = focused
        DispatchQueue.main.async {
            guard view.window != nil else { return }
            let wants = context.coordinator.wantsFocus
            if wants && !view.isFirstResponder { view.becomeFirstResponder() }
            if !wants && view.isFirstResponder { view.resignFirstResponder() }
        }
    }

    /// The height the box asks for: as tall as its text, capped. The caller's
    /// own `.frame(minHeight:alignment:)` still decides where a short line
    /// sits — centred in the resting pill, at the top of the focused card.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerUITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        let line = uiView.font?.lineHeight ?? UIFont.systemFont(ofSize: fontSize).lineHeight
        let content = max(uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height, line)
        let cap = maxLines.map { line * CGFloat($0) } ?? (proposal.height ?? content)
        return CGSize(width: width, height: min(content, cap))
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text, focused: $focused) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var text: Binding<String>
        var focused: Binding<Bool>
        var wantsFocus = false

        init(text: Binding<String>, focused: Binding<Bool>) {
            self.text = text
            self.focused = focused
        }

        func textViewDidChange(_ textView: UITextView) {
            if text.wrappedValue != textView.text { text.wrappedValue = textView.text }
            (textView as? ComposerUITextView)?.placeholderLabel.isHidden = !textView.text.isEmpty
        }

        // Only when it actually moved: an unchanged write still re-renders the
        // composer, and the composer's morph is animated on this very flag.
        func textViewDidBeginEditing(_ textView: UITextView) {
            if !focused.wrappedValue { focused.wrappedValue = true }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if focused.wrappedValue { focused.wrappedValue = false }
        }
    }
}

/// The text view that says yes to Paste. Everything the clipboard holds that
/// the composer would attach goes to the same intake a drop uses; text is
/// still the field's own business, pasted as text.
final class ComposerUITextView: UITextView {
    let placeholderLabel = UILabel()
    var onPaste: (([NSItemProvider]) -> Void)?

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        placeholderLabel.numberOfLines = 1
        placeholderLabel.lineBreakMode = .byTruncatingTail
        placeholderLabel.textColor = .placeholderText
        // The field already carries the placeholder as its own label; a second
        // element would read the prompt out twice.
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

    /// Whether the clipboard is carrying something for the strip, WITHOUT
    /// reading it: `types(forItemSet:)` answers with names only, and a read
    /// nobody asked for puts iOS's own banner over the app.
    private var clipboardHasAttachment: Bool {
        ComposerIntake.hasAttachment(in: UIPasteboard.general.types(forItemSet: nil) ?? [])
    }

    /// WHETHER PASTE IS DRAWN AT ALL. A text field turns the item down when
    /// the clipboard holds no text, which is what "there is no Paste" looks
    /// like from the outside.
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), clipboardHasAttachment { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    /// The same `NSItemProvider` list a drop delivers, so size caps, names and
    /// refusals are decided in one place. A clipboard carrying BOTH a picture
    /// and its text attaches the picture and leaves the text alone: two things
    /// arriving from one paste is the surprise, not the convenience.
    override func paste(_ sender: Any?) {
        guard let onPaste, clipboardHasAttachment else { return super.paste(sender) }
        let providers = UIPasteboard.general.itemProviders
            .filter { ComposerIntake.isAttachment($0.registeredTypeIdentifiers) }
        guard !providers.isEmpty else { return super.paste(sender) }
        onPaste(providers)
    }
}
