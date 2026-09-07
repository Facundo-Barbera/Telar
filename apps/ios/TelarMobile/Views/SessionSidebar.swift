import SwiftUI

struct SessionSidebar: View {
    let settings: AppSettings
    let inbox: MergedInbox
    @Binding var selection: ScopedSessionID?
    let newSession: () -> Void
    let openSettings: () -> Void
    let resumeDraft: (MobileDraft) -> Void
    @State private var query = ""
    @State private var projectFilter: String?
    @State private var orders: [HostID: [String]] = [:]
    @State private var collapsed: Set<String> = []
    @State private var snoozedOpen = false
    @State private var settledOpen = false
    @State private var settledLimit = 25
    @State private var layoutError: String?
    @AppStorage("telar.sidebar.collapsed") private var savedCollapsed = ""

    private var model: SidebarModel {
        SidebarModel(sessions: inbox.sections.active, names: inbox.projectName, orders: orders)
    }
    private var all: [HostedSession] { inbox.sections.active + inbox.sections.tail }
    private func matches(_ row: HostedSession) -> Bool {
        let key = "\(row.hostId.uuidString):\(row.session.projectId ?? "")"
        guard projectFilter == nil || projectFilter == key else { return false }
        return query.isEmpty || [row.session.title, inbox.projectName(row) ?? "", settings.host(row.hostId)?.name ?? ""]
            .contains { $0.localizedStandardContains(query) }
    }

    var body: some View {
        List(selection: $selection) {
            ForEach(inbox.failures) { failure in
                Label(failure.needsPairing ? "\(hostName(failure.hostId)) needs pairing" : "\(hostName(failure.hostId)) is offline · showing saved sessions", systemImage: failure.needsPairing ? "lock" : "wifi.slash")
                    .font(.caption).foregroundStyle(Theme.statusAmber)
            }
            if let layoutError { Text(layoutError).font(.caption).foregroundStyle(Theme.statusRed) }
            if !query.isEmpty {
                ForEach(all.filter(matches)) { row in sessionRow(row) }
                if all.filter(matches).isEmpty { Text("No matching sessions").foregroundStyle(Theme.textMuted) }
            } else {
                ForEach(MobileDrafts.shared.drafts.filter { draft in
                    settings.host(draft.hostId) != nil && (inbox.filter == nil || inbox.filter == draft.hostId)
                }) { draft in
                    Button { resumeDraft(draft) } label: {
                        Label(draft.title.isEmpty ? String(draft.prompt.prefix(60)) : draft.title, systemImage: "pencil")
                            .font(.subheadline).lineLimit(1)
                    }.contextMenu {
                        Button("Discard draft", role: .destructive) { MobileDrafts.shared.remove(host: draft.hostId, project: draft.project.id) }
                    }
                }
                if !model.attention.filter(matches).isEmpty {
                    Section("Needs you") {
                        ForEach(model.attention.filter(matches)) { row in sessionRow(row) }
                    }
                }
                if !model.pinned.filter(matches).isEmpty {
                    Section {
                        ForEach(model.pinned.filter(matches)) { row in sessionRow(row) }
                    }
                }
                ForEach(model.projects.filter { projectFilter == nil || $0.id == projectFilter }) { group in
                    Section {
                        if !collapsed.contains(group.id) {
                            ForEach(group.sessions) { row in sessionRow(row) }
                        }
                    } header: {
                        Button {
                            if collapsed.contains(group.id) { collapsed.remove(group.id) } else { collapsed.insert(group.id) }
                            savedCollapsed = collapsed.sorted().joined(separator: "\n")
                        } label: {
                            HStack {
                                Image(systemName: collapsed.contains(group.id) ? "chevron.right" : "chevron.down")
                                Text(group.name)
                                Spacer()
                                if settings.hosts.count > 1 { Text(hostName(group.hostId)).font(.caption2) }
                            }.foregroundStyle(Theme.textMuted)
                        }
                        .accessibilityLabel("\(group.name), \(collapsed.contains(group.id) ? "collapsed" : "expanded")")
                        .contextMenu {
                            Button("Move project up", systemImage: "arrow.up") { Task { await move(group, offset: -1) } }
                            Button("Move project down", systemImage: "arrow.down") { Task { await move(group, offset: 1) } }
                        }
                        .draggable(group.id)
                        .dropDestination(for: String.self) { ids, _ in
                            guard let id = ids.first, let source = model.projects.first(where: { $0.id == id }), source.hostId == group.hostId else { return false }
                            Task { await place(source, before: group) }
                            return true
                        }
                    }
                }
                shelf("Snoozed", rows: inbox.sections.snoozed.sorted { ($0.session.snoozedUntil ?? 0) < ($1.session.snoozedUntil ?? 0) }, open: $snoozedOpen)
                shelf("Settled", rows: inbox.sections.settled, open: $settledOpen)
            }
            if inbox.loaded && all.isEmpty {
                ContentUnavailableView("Your work starts here", systemImage: "text.bubble", description: Text("Start a conversation or pick up work from your Mac."))
            }
        }
        .listStyle(.sidebar)
        .listSectionSpacing(12)
        .scrollContentBackground(.hidden)
        .background(Theme.sheet)
        .navigationTitle("Telar")
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search sessions, projects, Macs")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("New conversation", systemImage: "square.and.pencil", action: newSession).keyboardShortcut("n", modifiers: .command)
            }
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Picker("Mac", selection: Bindable(inbox).filter) {
                        Text("All Macs").tag(nil as HostID?)
                        ForEach(settings.hosts) { Text($0.name).tag(Optional($0.id)) }
                    }
                    Picker("Project", selection: $projectFilter) {
                        Text("All projects").tag(nil as String?)
                        ForEach(projectOptions) { Text($0.name).tag(Optional($0.id)) }
                    }
                } label: { Label(inbox.filter.map(hostName) ?? "All Macs", systemImage: "line.3.horizontal.decrease") }
            }
        }
        .safeAreaInset(edge: .bottom) {
            Button(action: openSettings) {
                Label("Settings", systemImage: "gearshape").frame(maxWidth: .infinity, alignment: .leading).padding()
            }.keyboardShortcut(",", modifiers: .command).background(Theme.sheet)
        }
        .refreshable { await inbox.refresh(); await loadOrders() }
        .task {
            collapsed = Set(savedCollapsed.split(separator: "\n").map(String.init))
            await loadOrders()
        }
        .onChange(of: inbox.filter) { projectFilter = nil }
    }

    private var projectOptions: [SidebarProject] { SidebarModel(sessions: all.map { row in
        var session = row.session; session.activity = .idle; session.settledOverride = nil
        return HostedSession(hostId: row.hostId, session: session)
    }, names: inbox.projectName).projects }

    private func hostName(_ id: HostID) -> String { settings.host(id)?.name ?? "Mac" }

    private func sessionRow(_ row: HostedSession) -> some View {
        NavigationLink(value: row.id) {
            VStack(alignment: .leading, spacing: 7) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if row.session.settledOverride == "active" { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(Theme.accent) }
                    Text(row.session.title).font(Theme.rowTitle).lineLimit(2)
                }
                HStack {
                    ActivityBadge(activity: row.session.activity)
                    Text(row.session.activity == .blocked ? "Needs you" : row.session.activity == .idle ? (row.session.lastTurnFailed == true ? "Failed" : "Idle") : row.session.activity.rawValue.capitalized)
                        .font(.caption).foregroundStyle(Theme.textMuted)
                    Spacer(minLength: 4)
                    if settings.hosts.count > 1 { Text(hostName(row.hostId)).font(.caption2).foregroundStyle(Theme.textMuted) }
                }
            }.padding(.vertical, 5)
                .opacity(inbox.staleHosts.contains(row.hostId) ? 0.6 : 1)
        }
        .contextMenu {
            Button(row.session.settledOverride == "active" ? "Unpin" : "Pin", systemImage: "pin") {
                Task { await patch(row, SessionPatch(settledOverride: row.session.settledOverride == "active" ? nil : "active", clearSettledOverride: row.session.settledOverride == "active")) }
            }
            Button("Snooze for one hour", systemImage: "moon.zzz") {
                Task { await patch(row, SessionPatch(snoozedUntil: Int(Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000))) }
            }
            Button("Settle", systemImage: "checkmark") { Task { await inbox.setSettled(row.id, true) } }
            Button("Return to active", systemImage: "arrow.uturn.backward") { Task { await patch(row, SessionPatch(settledOverride: "active", clearSnooze: true)) } }
            if let base = settings.host(row.hostId)?.baseURL {
                ShareLink(item: row.session.cockpitURL(base: base)) { Label("Share cockpit link", systemImage: "link") }
            }
        }
    }

    @ViewBuilder private func shelf(_ name: String, rows: [HostedSession], open: Binding<Bool>) -> some View {
        let filtered = rows.filter(matches)
        if !filtered.isEmpty {
            Section {
                if open.wrappedValue {
                    ForEach(filtered.prefix(settledLimit)) { row in sessionRow(row) }
                    if filtered.count > settledLimit { Button("Show more") { settledLimit += 25 } }
                }
            } header: {
                Button { open.wrappedValue.toggle() } label: {
                    HStack {
                        Image(systemName: open.wrappedValue ? "chevron.down" : "chevron.right")
                        Text(name); Spacer(); Text("\(filtered.count)").monospacedDigit()
                    }
                }.foregroundStyle(Theme.textMuted)
            }
        }
    }

    private func patch(_ row: HostedSession, _ patch: SessionPatch) async {
        do { try await settings.api(for: row.hostId)?.patchSession(row.session.id, patch: patch); await inbox.refresh() }
        catch { layoutError = error.localizedDescription }
    }
    private func loadOrders() async {
        for host in settings.hosts {
            if let order = try? await settings.api(for: host.id)?.sidebarLayout() { orders[host.id] = order }
        }
    }
    private func move(_ group: SidebarProject, offset: Int) async {
        let peers = model.projects.filter { $0.hostId == group.hostId }
        guard let index = peers.firstIndex(where: { $0.id == group.id }), peers.indices.contains(index + offset) else { return }
        var order = peers.map(\.projectId); order.swapAt(index, index + offset)
        await saveOrder(order, host: group.hostId)
    }
    private func place(_ source: SidebarProject, before target: SidebarProject) async {
        guard source.id != target.id else { return }
        var order = model.projects.filter { $0.hostId == source.hostId }.map(\.projectId)
        order.removeAll { $0 == source.projectId }
        order.insert(source.projectId, at: order.firstIndex(of: target.projectId) ?? 0)
        await saveOrder(order, host: source.hostId)
    }
    private func saveOrder(_ order: [String], host: HostID) async {
        let previous = orders[host]; orders[host] = order
        do {
            // Preserve keys for projects not currently visible on the phone.
            let rest = (previous ?? []).filter { !order.contains($0) }
            try await settings.api(for: host)?.setSidebarLayout(order + rest)
            orders[host] = order + rest; layoutError = nil
        } catch { orders[host] = previous; layoutError = "Couldn't save project order. Try again when the Mac is connected." }
    }
}
