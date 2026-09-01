import SwiftUI

/// The inbox, wearing t3 mobile's thread-list anatomy: one flat list — an
/// active block of edge-to-edge three-line rows (no card fill; color and
/// hierarchy carry state), then a "Settled" divider and a receded slim tail.
/// Activity never reorders the active block. A List so rows get swipe
/// actions: full-swipe always commits the lifecycle verb, never delete.
struct InboxView: View {
    let api: any EngineAPI
    @State private var store: InboxStore
    /// t3's pagination: 10 settled built initially, +25 per "Show more".
    @State private var settledLimit = 10
    @Environment(\.scenePhase) private var scenePhase

    init(api: any EngineAPI) {
        self.api = api
        _store = State(initialValue: InboxStore(api: api))
    }

    var body: some View {
        List {
            if let error = store.lastError {
                HStack(spacing: 6) {
                    Image(systemName: "wifi.exclamationmark").font(.system(size: 11))
                    Text(error).font(.system(size: 13))
                }
                .foregroundStyle(Theme.statusAmber)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
            }

            ForEach(store.sections.active) { session in
                ThreadCardRow(session: session, projectName: projectName(session))
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparatorTint(Theme.borderSubtle)
                    .alignmentGuide(.listRowSeparatorLeading) { _ in 20 }
                    .overlay { NavigationLink(value: session.id) { EmptyView() }.opacity(0) }
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button {
                            Task { await store.setSettled(session.id, true) }
                        } label: {
                            Label("Settle", systemImage: "checkmark")
                        }
                        .tint(Theme.textTertiary)
                    }
            }

            if !store.sections.tail.isEmpty {
                SettledDivider()
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets())
                ForEach(store.sections.tail.prefix(settledLimit)) { session in
                    SlimThreadRow(session: session, snoozed: store.sections.snoozed.contains { $0.id == session.id })
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets())
                        .overlay { NavigationLink(value: session.id) { EmptyView() }.opacity(0) }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button {
                                Task { await store.setSettled(session.id, false) }
                            } label: {
                                Label("Un-settle", systemImage: "arrow.uturn.backward")
                            }
                            .tint(Theme.textTertiary)
                        }
                }
                if store.sections.tail.count > settledLimit {
                    Button {
                        settledLimit += 25
                    } label: {
                        Text("Show more (\(store.sections.tail.count - settledLimit) settled hidden)")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Theme.textMuted2)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .strokeBorder(Theme.border, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                            )
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
            }

            if store.loaded && store.sections.isEmpty {
                ContentUnavailableView(
                    "No sessions",
                    systemImage: "tray",
                    description: Text("Sessions started on the Mac appear here.")
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .padding(.top, 60)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .refreshable { await store.refresh() }
        .task { store.start() }
        .onDisappear { store.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.start() } else { store.stop() }
        }
    }

    private func projectName(_ session: Session) -> String? {
        session.projectId.flatMap { store.projectNames[$0] }
    }
}

/// "Settled" + a hairline filling the width — the list's only header.
struct SettledDivider: View {
    var body: some View {
        HStack(spacing: 10) {
            Text("Settled")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.textTertiary)
            Rectangle().fill(Theme.border).frame(height: 1)
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 6)
    }
}

/// The active row: three lines, edge-to-edge, px-20 py-10. Status replaces
/// the timestamp when non-ready — only act-now / in-motion / broken get
/// color; ready shows the relative time in tertiary.
struct ThreadCardRow: View {
    let session: Session
    let projectName: String?

    private var status: (label: String, color: Color)? {
        if session.lastTurnFailed == true && session.activity == .idle {
            return ("Failed", Theme.statusRed)
        }
        switch session.activity {
        case .blocked: return ("Approval", Theme.statusAmber)
        case .working: return ("Working", Theme.statusSky)
        case .queued: return ("Queued", Theme.statusSky)
        case .monitoring: return ("Monitoring", Theme.statusSky)
        case .idle: return nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted2)
                Text(projectName ?? "No project")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.textMuted2)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let status {
                    HStack(spacing: 5) {
                        if session.activity == .working {
                            SteppedPulseDot(color: status.color)
                        }
                        Text(status.label)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(status.color)
                    }
                } else {
                    Text(relativeTime(session.activityAt ?? session.updatedAt))
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textTertiary)
                        .tabularNumbers()
                }
            }
            Text(session.title)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Theme.text)
                .lineLimit(2)
            HStack(spacing: 8) {
                Text(session.workspace.branch ?? session.workspace.mode)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(Theme.textMuted2)
                    .lineLimit(1)
                Text("·").foregroundStyle(Theme.textTertiary)
                Text(session.driver)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textTertiary)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

/// The receded state: one line, min 44pt, favicon at 40%, regular-weight
/// muted title, mono tertiary timestamp, no hairline, no metadata.
struct SlimThreadRow: View {
    let session: Session
    let snoozed: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: snoozed ? "clock" : "folder")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textMuted2)
                .opacity(0.4)
            Text(session.title)
                .font(.system(size: 16))
                .foregroundStyle(Theme.textMuted2)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(relativeTime(session.updatedAt))
                .font(.system(size: 14, design: .monospaced))
                .foregroundStyle(Theme.textTertiary)
                .tabularNumbers()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

/// Row surface responds to interaction only — pressed state is the hover
/// fill. Used by request-card action buttons.
struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Theme.fill : .clear)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusRow))
            .animation(.easeInOut(duration: 0.15), value: configuration.isPressed)
    }
}

/// Kept for the session header, where only the dot fits.
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
