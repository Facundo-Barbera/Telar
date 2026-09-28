import SwiftUI

struct SessionFamilyToggle: View {
    let family: SessionFamily
    let open: Bool
    let toggle: () -> Void

    var body: some View {
        Button {
            withAnimation(.snappy(duration: 0.2)) { toggle() }
        } label: {
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold)).foregroundStyle(Theme.textMuted)
                .rotationEffect(.degrees(open ? 90 : 0))
                .overlay(alignment: .topTrailing) {
                    if family.needsYou > 0 { Circle().fill(Theme.statusRed).frame(width: 6, height: 6).offset(x: 4, y: -3) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(label)
    }

    private var label: String {
        let count = family.children.count
        var parts = ["\(open ? "Hide" : "Show") \(count) \(count == 1 ? "sub-session" : "sub-sessions")"]
        if family.needsYou > 0 { parts.append("\(family.needsYou) \(family.needsYou == 1 ? "needs" : "need") you") }
        return parts.joined(separator: ", ")
    }
}

struct SessionStatusSlot: View {
    let session: Session

    var body: some View {
        let now = Timestamp(Date().timeIntervalSince1970 * 1000)
        if let until = session.snoozedUntil, until > now, session.activity != .blocked {
            HStack(spacing: 3) {
                Image(systemName: "alarm").font(.system(Theme.captionTiny))
                Text(relativeTime(until)).monospacedDigit()
            }
            .font(.caption2).foregroundStyle(Theme.textMuted.opacity(0.7))
        } else if session.activity == .blocked {
            HStack(spacing: 3) {
                Image(systemName: "circle.circle").font(.system(Theme.captionTiny))
                Text("Needs you")
            }
            .font(.caption2.weight(.medium)).foregroundStyle(Theme.statusAmber)
        } else if session.activity == .working || session.activity == .queued {
            HStack(spacing: 3) {
                SteppedPulseDot(color: Theme.statusSky)
                Text(session.activity == .queued ? "Queued" : "Working")
            }
            .font(.caption2.weight(.medium)).foregroundStyle(Theme.statusSky)
        } else if session.activity == .monitoring {
            Text("Monitoring").font(.caption2.weight(.medium)).foregroundStyle(Theme.statusSky)
        } else if session.lastTurnFailed == true {
            Text("Failed").font(.caption2.weight(.medium)).foregroundStyle(Theme.statusRed)
        } else {
            Text(relativeTime(session.activityAt ?? session.updatedAt))
                .font(.caption2).foregroundStyle(Theme.textMuted.opacity(0.7)).monospacedDigit()
        }
    }
}

struct UnreadDot: View {
    let session: Session

    var body: some View {
        if Settling.showsUnreadMark(session) {
            Circle().fill(Theme.accent).frame(width: 6, height: 6)
                .accessibilityLabel("Unread answer")
        }
    }
}

struct SessionChildRow: View {
    let session: Session
    @ScaledMetric(relativeTo: .footnote) private var providerMark: CGFloat = 12

    var body: some View {
        HStack(spacing: 6) {
            ProviderIconView(driver: session.driver, size: providerMark).opacity(0.6)
            UnreadDot(session: session)
            Text(session.title.isEmpty ? "Untitled session" : session.title)
                .font(.footnote).foregroundStyle(Theme.text.opacity(Settling.showsUnreadMark(session) ? 1 : 0.7))
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            SessionStatusSlot(session: session)
        }
    }
}
