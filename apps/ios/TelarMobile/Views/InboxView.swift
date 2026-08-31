import SwiftUI

/// The inbox, wearing t3code's thread-list anatomy: three-line card rows for
/// live work, slim rows for the shelf, status carried as colored text + dot
/// in the row content (surface is reserved for interaction), section headers
/// as a small label beside a hairline rule.
struct InboxView: View {
    let api: any EngineAPI
    @State private var store: InboxStore
    @State private var showHidden = false
    @Environment(\.scenePhase) private var scenePhase

    init(api: any EngineAPI) {
        self.api = api
        _store = State(initialValue: InboxStore(api: api))
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 1) {
                if let error = store.lastError {
                    HStack(spacing: 6) {
                        Image(systemName: "wifi.exclamationmark").font(.system(size: 11))
                        Text(error).font(Theme.metaSmall)
                    }
                    .foregroundStyle(Theme.statusAmber)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                }
                section("Needs you", store.sections.needsYou)
                section("Working", store.sections.working)
                section("Quiet", store.sections.quiet)
                if showHidden {
                    section("Snoozed & settled", store.sections.hidden, slim: true)
                }
                if !store.sections.hidden.isEmpty {
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) { showHidden.toggle() }
                    } label: {
                        Text(showHidden ? "Hide snoozed & settled" : "Show all (\(store.sections.hidden.count) hidden)")
                            .font(Theme.metaSmall)
                            .foregroundStyle(Theme.textMuted)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                    }
                    .buttonStyle(.plain)
                }
                if store.loaded && store.sections.isEmpty {
                    ContentUnavailableView(
                        "No live sessions",
                        systemImage: "tray",
                        description: Text("Sessions started on the Mac appear here.")
                    )
                    .padding(.top, 80)
                }
            }
            .padding(.horizontal, 8)
            .padding(.top, 4)
        }
        .background(Theme.canvas)
        .refreshable { await store.refresh() }
        .task { store.start() }
        .onDisappear { store.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.start() } else { store.stop() }
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ sessions: [Session], slim: Bool = false) -> some View {
        if !sessions.isEmpty {
            HStack(spacing: 8) {
                Text(title)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.textMuted)
                Rectangle().fill(Theme.border).frame(height: 1)
            }
            .padding(.horizontal, 10)
            .padding(.top, 14)
            .padding(.bottom, 4)
            ForEach(sessions) { session in
                NavigationLink(value: session.id) {
                    if slim {
                        SlimSessionRow(session: session, projectName: projectName(session))
                    } else {
                        SessionRowView(session: session, projectName: projectName(session))
                    }
                }
                .buttonStyle(RowButtonStyle())
            }
        }
    }

    private func projectName(_ session: Session) -> String? {
        session.projectId.flatMap { store.projectNames[$0] }
    }
}

/// Row surface responds to interaction only — t3code's rule. Pressed state
/// is the hover fill.
struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Theme.fill : .clear)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusRow))
            .animation(.easeInOut(duration: 0.15), value: configuration.isPressed)
    }
}

/// The card row: 78pt, three lines — project, title, workspace meta — with
/// status in the top-right slot.
struct SessionRowView: View {
    let session: Session
    let projectName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textMuted.opacity(0.7))
                Text(projectName ?? "No project")
                    .font(Theme.metaSmall)
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                Spacer(minLength: 8)
                StatusPill(session: session)
            }
            .frame(height: 18)
            Text(session.title)
                .font(Theme.rowTitle)
                .foregroundStyle(Theme.text)
                .lineLimit(1)
            HStack(spacing: 6) {
                if session.workspace.mode == "worktree" {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 9))
                        .foregroundStyle(Theme.textMuted.opacity(0.5))
                }
                Text(session.workspace.branch ?? session.driver)
                    .font(Theme.metaSmall)
                    .foregroundStyle(Theme.textMuted.opacity(0.8))
                    .lineLimit(1)
                Text(relativeTime(session.activityAt ?? session.updatedAt))
                    .font(Theme.metaSmall)
                    .foregroundStyle(Theme.textMuted.opacity(0.6))
                    .tabularNumbers()
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(height: 78)
        .contentShape(Rectangle())
    }
}

/// The shelf row: 36pt, one line, receded.
struct SlimSessionRow: View {
    let session: Session
    let projectName: String?

    var body: some View {
        HStack(spacing: 10) {
            Text(session.title)
                .font(Theme.body)
                .foregroundStyle(Theme.textMuted.opacity(0.75))
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(relativeTime(session.updatedAt))
                .font(Theme.metaSmall)
                .foregroundStyle(Theme.textMuted.opacity(0.5))
                .tabularNumbers()
        }
        .padding(.horizontal, 10)
        .frame(height: 36)
        .contentShape(Rectangle())
    }
}

/// t3code's status vocabulary — colored label + dot, motion strictly reserved
/// for "working".
struct StatusPill: View {
    let session: Session

    private var status: (label: String, color: Color, pulses: Bool)? {
        if session.lastTurnFailed == true && session.activity == .idle {
            return ("Failed", Theme.statusRed, false)
        }
        switch session.activity {
        case .blocked: return ("Approval", Theme.statusAmber, false)
        case .working: return ("Working", Theme.statusSky, true)
        case .queued: return ("Queued", Theme.statusSky, false)
        case .monitoring: return ("Monitoring", Theme.statusSky, false)
        case .idle: return nil
        }
    }

    var body: some View {
        if let status {
            HStack(spacing: 5) {
                if status.pulses {
                    SteppedPulseDot(color: status.color)
                } else {
                    Circle().fill(status.color).frame(width: 7, height: 7)
                }
                Text(status.label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(status.color)
            }
        }
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
