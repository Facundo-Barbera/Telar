import SwiftUI
import UIKit

/// The settings surfaces' shared visual kit — the same card idiom as
/// NewSessionView's project list (inset 24pt-radius Theme.card on
/// Theme.sheet), so Settings stops looking like a stock Form bolted onto a
/// styled app. Rows are 16pt/semibold with 27pt leading glyphs, separated by
/// borderSubtle hairlines; section labels are t3's small tertiary caps.
struct SettingsCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}

struct SettingsSectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 12, weight: .semibold))
            .kerning(0.6)
            .foregroundStyle(Theme.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
    }
}

/// The explanatory line under a card — quiet, never inside it.
struct SettingsFootnote: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.system(size: 13))
            .foregroundStyle(Theme.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 8)
    }
}

struct CardDivider: View {
    var body: some View {
        Rectangle().fill(Theme.borderSubtle).frame(height: 1)
    }
}

/// One card row: glyph, title+subtitle, trailing accessory.
struct CardRow<Trailing: View>: View {
    let icon: String
    var iconColor: Color = Theme.textMuted
    let title: String
    var titleColor: Color = Theme.text
    var subtitle: String?
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 17))
                .foregroundStyle(iconColor)
                .frame(width: 27, height: 27)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(titleColor)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .contentShape(Rectangle())
    }
}

/// A tappable row ending in the list chevron.
struct CardNavRow: View {
    let icon: String
    let title: String
    var subtitle: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            CardRow(icon: icon, title: title, subtitle: subtitle) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.chevron)
            }
        }
        .buttonStyle(.plain)
    }
}

/// A labelled text field inside a card: label above, 16pt field below.
struct CardField: View {
    let label: String
    let placeholder: String
    @Binding var text: String
    var mono = false
    var keyboard: UIKeyboardType = .default

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textMuted)
            TextField(placeholder, text: $text)
                .font(mono ? .system(size: 15, design: .monospaced) : .system(size: 16))
                .foregroundStyle(Theme.text)
                .keyboardType(keyboard)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

/// The 50pt full-width primary action — t3's near-white/near-black fill,
/// never accent-colored.
struct PrimaryActionButton: View {
    let title: String
    var busy = false
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                if busy {
                    ProgressView().tint(Theme.primaryGlyph)
                } else {
                    Text(title)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(enabled ? Theme.primaryGlyph : Theme.textMuted)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .background(enabled ? AnyShapeStyle(Theme.primaryFill) : AnyShapeStyle(Theme.subtleStrong))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .disabled(!enabled || busy)
    }
}

/// An inline status banner — icon + message on the status color, inside its
/// own card row.
struct StatusBanner: View {
    let icon: String
    let color: Color
    let title: String
    var detail: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 17))
                .foregroundStyle(color)
                .frame(width: 27, height: 27)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}
