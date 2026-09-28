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
    /// WHILE THE MICROPHONE IS OPEN (#561), which tints the caret. The field's
    /// `tintColor` is the caret, so this is one property rather than a drawing.
    var listening = false
    /// THE WORDS STILL BEING REVISED, as character offsets into `text` (#561).
    /// Drawn dimmer so settled words are tellable from words still moving.
    /// `nil` between utterances and whenever nobody is dictating.
    var interim: Range<Int>?
    /// WHERE THE CARET IS, IN THIS FIELD'S OWN COORDINATES (#561), reported up
    /// so the composer can float a badge beside it.
    ///
    /// A BINDING RATHER THAN A RETURN, because the question is asked by a view
    /// that cannot reach a `UITextView`: SwiftUI owns the overlay and UIKit
    /// owns the geometry, and this is the seam. Written only when it MOVES —
    /// an unchanged write here would re-render the composer on every layout
    /// pass of a box that is laid out on every keystroke.
    var caretRect: Binding<CGRect?>?
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
        context.coordinator.caretRect = caretRect
        view.onPaste = onPaste
        context.coordinator.sync(view, to: text)

        let font = UIFontMetrics.default.scaledFont(for: .systemFont(ofSize: fontSize))
        if view.font != font {
            view.font = font
            view.placeholderLabel.font = font
        }

        // THE DIM GOES ON AFTER THE TEXT, and only when there is a run to dim
        // (#561). It is an ATTRIBUTE edit and nothing else — see
        // `applyInterim` — so it runs after the sync above without undoing what
        // that just told the keyboard.
        view.tintColor = listening ? UIColor(Theme.accent) : nil
        view.applyInterim(interim, font: font, color: UIColor(Theme.text))
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
    ///
    /// WHAT THE LAYOUT OFFERED IS A CAP TOO, and it is the one that was
    /// missing. `maxLines` says how far a growing draft may push the card
    /// open; the proposal says how far the page can actually let it — and with
    /// the keyboard up the page is the smaller of the two, because the
    /// transcript and the composer are dividing what is left above the
    /// keyboard. Answering with more than was offered does not win the room:
    /// SwiftUI places the field at the size it asked for while the card behind
    /// it is drawn for the size it was granted, and the difference is the last
    /// line of the draft, rendered on the page below the card.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerUITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        let line = uiView.font?.lineHeight ?? UIFont.systemFont(ofSize: fontSize).lineHeight
        let content = max(uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height, line)
        let offered = proposal.height.flatMap { $0.isFinite ? $0 : nil } ?? .greatestFiniteMagnitude
        let cap = min(maxLines.map { line * CGFloat($0) } ?? .greatestFiniteMagnitude, offered)
        // NEVER BELOW ONE LINE: a zero-height proposal is the layout asking how
        // small the box could be, not an offer to draw it away.
        return CGSize(width: width, height: max(min(content, cap), line))
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text, focused: $focused) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var text: Binding<String>
        var focused: Binding<Bool>
        var wantsFocus = false
        /// Where to report the caret, when anybody is drawing beside it (#561).
        var caretRect: Binding<CGRect?>?
        /// THE DRAFT THIS FIELD ITSELF PUBLISHED, last time it did (#624). The
        /// whole of the echo guard: see `sync`.
        private var published: String?
        /// AN EXTERNAL WRITE IS IN PROGRESS, so the delegate callbacks it
        /// provokes are this class talking to itself. `replace(_:withText:)`
        /// reports back the way a keystroke does — unlike the assignment it
        /// replaces, which reported nothing — and those reports arrive inside
        /// SwiftUI's own update pass, which is not a place to write state.
        private var applying = false

        init(text: Binding<String>, focused: Binding<Bool>) {
            self.text = text
            self.focused = focused
        }

        /// PUT THE BINDING'S DRAFT IN THE FIELD AS AN EDIT (#624), rather than
        /// as a new buffer.
        ///
        /// Three things are declined rather than applied, and each is a bug
        /// the old one-line assignment had:
        ///
        /// MID-COMPOSITION, NOTHING IS WRITTEN. A marked range is the keyboard
        /// half-way through a word — a Pinyin syllable, a Japanese reading, a
        /// dictation the system itself is revising — and text arriving under it
        /// ends the composition somewhere the person did not choose. The write
        /// is DROPPED, not deferred: the composition finishes, this field's own
        /// `textViewDidChange` pushes what the person actually typed back into
        /// the binding, and the next dictation frame sees a draft it did not
        /// write and re-merges against it (`DictationDraftWriter`). Deferring
        /// would mean replaying a value that was computed before the person
        /// finished the word, on top of the word they finished.
        ///
        /// A LATE ECHO IS NOT AN EDIT. The field publishes each keystroke into
        /// the binding and the binding comes back a render later; if the person
        /// typed again in between, that stale value would arrive here as a
        /// difference and undo the newer keystroke. A draft this field
        /// published is one the field already has, or has since moved past.
        ///
        /// AN UNCHANGED DRAFT IS NOT WORTH A ROUND TRIP through the input
        /// machinery, which is most update passes — SwiftUI calls
        /// `updateUIView` for state that has nothing to do with the text.
        func sync(_ view: ComposerUITextView, to next: String) {
            guard view.text != next, next != published, view.markedTextRange == nil else { return }
            applying = true
            let moved = view.apply(next)
            applying = false
            guard moved else { return }
            // THE CARET MOVED AND SOMETHING MAY BE DRAWN BESIDE IT (#561), but
            // not from inside the update pass — the same reason the
            // first-responder work below hops to the next turn of the loop.
            DispatchQueue.main.async { [weak self, weak view] in
                guard let self, let view else { return }
                report(view)
            }
        }

        func textViewDidChange(_ textView: UITextView) {
            (textView as? ComposerUITextView)?.placeholderLabel.isHidden = !textView.text.isEmpty
            guard !applying else { return }
            published = textView.text
            if text.wrappedValue != textView.text { text.wrappedValue = textView.text }
            report(textView)
        }

        // Only when it actually moved: an unchanged write still re-renders the
        // composer, and the composer's morph is animated on this very flag.
        func textViewDidBeginEditing(_ textView: UITextView) {
            if !focused.wrappedValue { focused.wrappedValue = true }
            report(textView)
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if focused.wrappedValue { focused.wrappedValue = false }
            // NO CARET, SO NOTHING TO DRAW BESIDE. The badge goes away with the
            // keyboard rather than hanging over a field nobody is in.
            if caretRect?.wrappedValue != nil { caretRect?.wrappedValue = nil }
        }

        /// The caret moved without the text changing — an arrow key on a
        /// hardware keyboard, a tap, a selection drag.
        func textViewDidChangeSelection(_ textView: UITextView) {
            guard !applying else { return }
            report(textView)
        }

        /// WRITTEN ONLY WHEN IT MOVED — see `caretRect`. `caretRect(for:)` is
        /// the field's own answer and already accounts for the text container's
        /// insets and the scroll offset, so what comes out is where the caret is
        /// drawn inside this view right now.
        private func report(_ textView: UITextView) {
            guard let caretRect else { return }
            let next = textView.selectedTextRange.map { textView.caretRect(for: $0.end) }
            // A caret rect can come back infinite while the field is between
            // layouts; an overlay placed on one would fly off the screen.
            let usable = next.flatMap { $0.isInfinite || $0.isNull ? nil : $0 }
            if caretRect.wrappedValue != usable { caretRect.wrappedValue = usable }
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

    /**
     SOMEBODY ELSE'S DRAFT, APPLIED AS AN EDIT (#624).

     `text = string` hands UIKit a new buffer and tells the keyboard nothing:
     the marked range, the inline prediction and the correction context all go,
     and because the assignment does not travel through `UITextInputDelegate`
     the keyboard never learns they went. It keeps correcting against the
     sentence it last saw. That is the whole of this issue — worst under
     dictation only because an interim transcript rewrites the draft several
     times a second, so the keyboard's context was being thrown away between
     one word and the next.

     So: find the run that actually differs and replace THAT, bracketed by the
     two calls that tell the keyboard to resync. `textWillChange` /
     `textDidChange` are the notifications UIKit sends itself when it edits the
     buffer, and an edit made from outside has to send them by hand or the
     keyboard is left holding a stale typing context — the same bug in a
     smaller range.

     Answers whether anything changed, so the caller can skip the work that
     only matters when it did.
     */
    @discardableResult func apply(_ next: String) -> Bool {
        guard let edit = ComposerTextEdit.replacement(from: text, to: next) else { return false }
        guard let start = position(from: beginningOfDocument, offset: edit.range.location),
              let end = position(from: start, offset: edit.range.length),
              let span = textRange(from: start, to: end)
        else {
            // A RANGE THE FIELD WILL NOT MAKE is not a reason to leave the draft
            // and the box disagreeing. Falling back to the assignment costs the
            // keyboard's context for one write, which is what every write used
            // to cost.
            text = next
            dimmed = nil
            return true
        }
        let selection = selectedRange
        inputDelegate?.textWillChange(self)
        replace(span, withText: edit.text)
        inputDelegate?.textDidChange(self)
        // THE CARET STAYS WHERE THE PERSON PUT IT unless the edit ran over it.
        // `replace` leaves it after the inserted text, which is right for a
        // dictation appending at the tail and wrong for one appending while
        // somebody is fixing a typo three words back.
        if let kept = ComposerTextEdit.selection(selection, after: edit.range, replacedBy: edit.text) {
            selectedRange = kept
        }
        // THE TEXT MOVED UNDER THE DIM, so what is drawn dim has to be worked
        // out again — the cache below is about frames where nothing moved.
        dimmed = nil
        return true
    }

    /// WHICH RUN IS CURRENTLY DRAWN DIM, so an unchanged frame does no work.
    private var dimmed: Range<Int>?

    /**
     THE WORDS STILL BEING REVISED, DRAWN DIMMER (#561).

     COLOUR ONLY, ON THE STORAGE THE FIELD ALREADY HAS (#624). This used to
     build a whole `NSAttributedString` from `text` and assign `attributedText`,
     which is the same wholesale replacement `apply` exists to avoid — it reset
     the keyboard's correction context on every interim frame, which on the
     dictation path is several times a second. An attribute edit changes no
     characters, so the marked range, the inline prediction and the correction
     context all survive it, and the selection does not need putting back by
     hand because nothing moved it.

     It stays guarded on `dimmed` all the same: interim frames are frequent and
     re-attributing a paragraph that is already drawn right is work for nothing.
     `apply` clears that cache when it moves the text, which is the one thing
     that can make a still-correct-looking span wrong.

     `typingAttributes` IS RESET AFTERWARDS. Without it the dim is sticky — the
     next character somebody types inherits the attributes at the insertion
     point, and a person who starts typing at the end of a guess would find
     their own words coming out grey.
     */
    func applyInterim(_ run: Range<Int>?, font: UIFont, color: UIColor) {
        let count = (text as NSString).length
        let clamped = run.flatMap { span -> Range<Int>? in
            let lower = min(max(0, span.lowerBound), count)
            let upper = min(max(lower, span.upperBound), count)
            return lower < upper ? lower ..< upper : nil
        }
        guard clamped != dimmed else { return }
        dimmed = clamped

        let base: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
        textStorage.beginEditing()
        // BACK TO PLAIN FIRST, so the run that stopped being unconfirmed a
        // frame ago is repainted rather than left grey.
        textStorage.setAttributes(base, range: NSRange(location: 0, length: count))
        if let clamped {
            textStorage.addAttribute(
                .foregroundColor,
                value: color.withAlphaComponent(0.45),
                range: NSRange(location: clamped.lowerBound, length: clamped.count)
            )
        }
        textStorage.endEditing()
        typingAttributes = base
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
