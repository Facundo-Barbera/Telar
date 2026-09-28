import SwiftUI

struct ComposerLabeledPill<Items: View>: View {
    let icon: String
    let label: String
    @ViewBuilder let items: () -> Items

    var body: some View {
        Menu {
            items()
        } label: {
            ComposerPillLabel(icon: icon, label: label)
        }
    }
}

struct ComposerPillLabel: View {
    let icon: String
    let label: String

    @ScaledMetric(relativeTo: .subheadline) private var height: CGFloat = 44
    @ScaledMetric(relativeTo: .subheadline) private var cap: CGFloat = 172

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon).font(.system(Theme.subhead)).foregroundStyle(Theme.text)
            Text(label)
                .font(.system(Theme.subhead, weight: .semibold))
                .lineLimit(1)
                .foregroundStyle(Theme.text)
            Image(systemName: "chevron.down").font(.system(Theme.caption, weight: .medium)).foregroundStyle(Theme.text)
        }
        .padding(.horizontal, 14)
        .frame(height: height)
        .frame(maxWidth: cap)
        .background(Theme.subtle)
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
    }
}

@ViewBuilder func composerMenuRow(_ label: String, selected: Bool) -> some View {
    if selected {
        Label(label, systemImage: "checkmark")
    } else {
        Text(label)
    }
}

struct ControlPillButton: View {
    let isRunning: Bool
    let canSend: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: isRunning ? "stop.fill" : "arrow.up")
                .foregroundStyle(isRunning ? Theme.dangerGlyph : (canSend ? Theme.primaryGlyph : Theme.textMuted))
                .scaledGlyphBox(44, glyph: 16, weight: .semibold)
                .background(isRunning ? Theme.dangerFill : (canSend ? Theme.primaryFill : Theme.subtleStrong))
                .clipShape(Circle())
        }
        .disabled(!isRunning && !canSend)
        .accessibilityLabel(isRunning ? "Stop the running turn" : "Send")
    }
}

struct ToolbarPill<Label: View>: View {
    enum Variant { case normal, danger }
    let variant: Variant
    let action: () -> Void
    @ViewBuilder let label: Label

    init(variant: Variant = .normal, action: @escaping () -> Void, @ViewBuilder label: () -> Label) {
        self.variant = variant
        self.action = action
        self.label = label()
    }

    var body: some View {
        Button(action: action) {
            label
                .foregroundStyle(variant == .danger ? Theme.dangerGlyph : Theme.text)
                .scaledSquare(44)
                .background(variant == .danger ? Theme.dangerFill : Theme.subtle)
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
        }
    }
}

extension View {
    @ViewBuilder func composerGlass(cornerRadius: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)

        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            self.background {
                ZStack {
                    shape.fill(Theme.composerSurface.opacity(0.85))
                    Color.clear.glassEffect(.regular, in: shape)
                }
                .allowsHitTesting(false)
            }
        } else {
            self.background(Theme.composerSurface)
                .clipShape(shape)
                .overlay(shape.strokeBorder(Theme.border, lineWidth: 1))
        }
        #else
        self.background(Theme.composerSurface)
            .clipShape(shape)
            .overlay(shape.strokeBorder(Theme.border, lineWidth: 1))
        #endif
    }
}
