import SwiftUI

struct ComposerControls {
    var model: AnyView = AnyView(EmptyView())
    var options: AnyView = AnyView(EmptyView())
}

extension EnvironmentValues {
    @Entry var composerPillsInMenu = false
}

struct ComposerLabeledPill<Items: View>: View {
    let icon: String
    let label: String
    @ViewBuilder let items: () -> Items
    @Environment(\.composerPillsInMenu) private var inMenu

    var body: some View {
        if inMenu {
            Menu { items() } label: { Label(label, systemImage: icon) }
        } else {
            Menu {
                items()
            } label: {
                ComposerPillLabel(icon: icon, label: label)
            }
        }
    }
}

struct RuntimeModePill: View {
    let mode: String?
    let onPick: (String) -> Void

    static let modes: [(String, String)] = [
        ("approval-required", "Supervised"),
        ("auto-accept-edits", "Auto-accept edits"),
        ("auto", "Auto"),
        ("full-access", "Full access"),
    ]

    var body: some View {
        ComposerLabeledPill(
            icon: "slider.horizontal.3",
            label: Self.modes.first { $0.0 == mode }?.1 ?? "Configuration"
        ) {
            ForEach(Self.modes, id: \.0) { value, label in
                Button { onPick(value) } label: { composerMenuRow(label, selected: value == mode) }
            }
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
