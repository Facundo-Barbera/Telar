import SwiftUI

struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Theme.fill : .clear)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusRow))
            .animation(.easeInOut(duration: 0.15), value: configuration.isPressed)
    }
}

struct ActivityBadge: View {
    let activity: SessionActivity

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .accessibilityLabel(String(describing: activity))
    }

    private var color: Color {
        switch activity {
        case .blocked: Theme.statusAmber
        case .working, .queued, .monitoring: Theme.statusSky
        case .idle: Theme.textMuted.opacity(0.4)
        }
    }
}

func relativeTime(_ timestamp: Timestamp) -> String {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .abbreviated
    return formatter.localizedString(for: timestamp.date, relativeTo: Date())
}
