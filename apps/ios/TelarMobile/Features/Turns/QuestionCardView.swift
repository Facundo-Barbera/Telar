import SwiftUI

struct QuestionCardView: View {
    @State var draft: QuestionDraft
    let maxHeight: CGFloat
    let submit: ([String: AnswerValue]) -> Void

    @State private var forward = true
    @ScaledMetric(relativeTo: .body) private var chrome: CGFloat = 96

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            ViewThatFits(in: .vertical) {
                page
                ScrollView { page }.scrollBounceBehavior(.basedOnSize)
            }
            .frame(maxHeight: max(160, maxHeight - chrome), alignment: .top)
            .id(draft.index)
            .transition(.push(from: forward ? .trailing : .leading))
            .contentShape(Rectangle())
            .gesture(swipe)
            navigation
        }
        .clipped()
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "questionmark.bubble")
                .font(.system(Theme.footnote, weight: .medium))
                .foregroundStyle(Theme.statusAmber)
                .accessibilityHidden(true)
            Text(draft.page.header ?? "Question")
                .font(.system(Theme.caption, weight: .semibold))
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Theme.subtle, in: Capsule())
            Spacer(minLength: 0)
            if draft.pages.count > 1 {
                Text("\(draft.index + 1) of \(draft.pages.count)")
                    .font(Theme.meta)
                    .foregroundStyle(Theme.textMuted)
                    .monospacedDigit()
                    .accessibilityLabel("Question \(draft.index + 1) of \(draft.pages.count)")
            }
        }
    }

    private var page: some View {
        let current = draft.page
        return VStack(alignment: .leading, spacing: 8) {
            Text(current.question)
                .font(Theme.bodyMedium)
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if current.multiple {
                Text("Pick any that apply")
                    .font(Theme.meta)
                    .foregroundStyle(Theme.textMuted)
            }
            ForEach(current.choices, id: \.self) { choice in
                option(choice, description: current.descriptions[choice], multiple: current.multiple)
            }
            TextField(current.choices.isEmpty ? "Your answer" : "Other…", text: Binding(
                get: { draft.customText },
                set: { draft.setCustom($0) }
            ), axis: .vertical)
            .font(Theme.body)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Theme.fill)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusControl))
            .hairline(Theme.radiusControl)
            .accessibilityLabel(current.choices.isEmpty ? "Your answer" : "Other answer")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func option(_ choice: String, description: String?, multiple: Bool) -> some View {
        let picked = draft.isSelected(choice)
        let glyph = multiple ? (picked ? "checkmark.square.fill" : "square") : (picked ? "checkmark.circle.fill" : "circle")
        return Button {
            draft.toggle(choice)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: glyph)
                    .foregroundStyle(picked ? Theme.accent : Theme.textMuted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(choice)
                        .font(Theme.body)
                        .foregroundStyle(Theme.text)
                    if let description {
                        Text(description)
                            .font(Theme.meta)
                            .foregroundStyle(Theme.textMuted)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(picked ? Theme.accent.opacity(0.12) : Theme.fill)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusRow))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusRow)
                    .strokeBorder(picked ? Theme.accent.opacity(0.6) : .clear, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(description.map { "\(choice). \($0)" } ?? choice)
        .accessibilityAddTraits(picked ? [.isButton, .isSelected] : .isButton)
    }

    private var navigation: some View {
        HStack(spacing: 8) {
            if draft.index > 0 {
                GhostButton("Back", tint: Theme.textMuted) { go(forward: false) }
            }
            Spacer(minLength: 0)
            Button(draft.isLast ? "Submit" : "Next") {
                if draft.isLast {
                    if let answers = draft.answers { submit(answers) }
                } else {
                    go(forward: true)
                }
            }
            .font(.system(Theme.footnote, weight: .semibold))
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .tint(Theme.accent)
            .disabled(draft.isLast ? draft.answers == nil : !draft.canAdvance)
        }
    }

    private var swipe: some Gesture {
        DragGesture(minimumDistance: 24).onEnded { value in
            guard abs(value.translation.width) > abs(value.translation.height) * 1.5 else { return }
            if value.translation.width < -40, !draft.isLast, draft.canAdvance { go(forward: true) }
            if value.translation.width > 40, draft.index > 0 { go(forward: false) }
        }
    }

    private func go(forward: Bool) {
        self.forward = forward
        withAnimation(.easeInOut(duration: 0.22)) {
            if forward { draft.advance() } else { draft.back() }
        }
    }
}
