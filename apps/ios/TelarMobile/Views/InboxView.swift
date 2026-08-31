import SwiftUI

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
        List {
            if let error = store.lastError {
                Label(error, systemImage: "wifi.exclamationmark")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            section("Needs you", store.sections.needsYou)
            section("Working", store.sections.working)
            section("Quiet", store.sections.quiet)
            if showHidden {
                section("Snoozed & settled", store.sections.hidden)
            }
            if !store.sections.hidden.isEmpty {
                Button(showHidden ? "Hide snoozed & settled" : "Show all (\(store.sections.hidden.count) hidden)") {
                    showHidden.toggle()
                }
                .font(.caption)
            }
            if store.loaded && store.sections.isEmpty {
                ContentUnavailableView(
                    "No live sessions",
                    systemImage: "tray",
                    description: Text("Sessions started on the Mac appear here.")
                )
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await store.refresh() }
        .task { store.start() }
        .onDisappear { store.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.start() } else { store.stop() }
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ sessions: [Session]) -> some View {
        if !sessions.isEmpty {
            Section(title) {
                ForEach(sessions) { session in
                    NavigationLink(value: session.id) {
                        SessionRowView(session: session, projectName: session.projectId.flatMap { store.projectNames[$0] })
                    }
                }
            }
        }
    }
}

struct SessionRowView: View {
    let session: Session
    let projectName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                ActivityBadge(activity: session.activity)
                Text(session.title)
                    .font(.subheadline)
                    .lineLimit(1)
                if session.lastTurnFailed == true {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
            }
            HStack(spacing: 6) {
                if let projectName {
                    Text(projectName)
                }
                Text(session.driver)
                Text(relativeTime(session.activityAt ?? session.updatedAt))
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

struct ActivityBadge: View {
    let activity: SessionActivity

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .accessibilityLabel(String(describing: activity))
    }

    private var color: Color {
        switch activity {
        case .blocked: .orange
        case .working: .blue
        case .queued: .cyan
        case .monitoring: .purple
        case .idle: .gray.opacity(0.4)
        }
    }
}

func relativeTime(_ timestamp: Timestamp) -> String {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .abbreviated
    return formatter.localizedString(for: timestamp.date, relativeTo: Date())
}
