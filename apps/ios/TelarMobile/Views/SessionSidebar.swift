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
    /// The row whose snooze sheet is up.
    @State private var snoozing: HostedSession?
    @AppStorage("telar.sidebar.collapsed") private var savedCollapsed = ""

    private var model: SidebarModel {
        SidebarModel(sessions: inbox.sections.active, names: inbox.projectName, icons: { inbox.project($0)?.icon }, orders: orders)
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
                            ForEach(group.sessions) { row in sessionRow(row, showsProject: false) }
                        }
                    } header: {
                        Button {
                            if collapsed.contains(group.id) { collapsed.remove(group.id) } else { collapsed.insert(group.id) }
                            savedCollapsed = collapsed.sorted().joined(separator: "\n")
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: collapsed.contains(group.id) ? "chevron.right" : "chevron.down")
                                ProjectAvatar(name: group.name, projectId: group.projectId, hostId: group.hostId, icon: group.icon, api: settings.api(for: group.hostId), size: 16)
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
        .sheet(item: $snoozing) { row in snoozeSheet(row) }
    }

    private var projectOptions: [SidebarProject] { SidebarModel(sessions: all.map { row in
        var session = row.session; session.activity = .idle; session.settledOverride = nil
        return HostedSession(hostId: row.hostId, session: session)
    }, names: inbox.projectName).projects }

    private func hostName(_ id: HostID) -> String { settings.host(id)?.name ?? "Mac" }

    private func sessionRow(_ row: HostedSession, showsProject: Bool = true) -> some View {
        NavigationLink(value: row.id) {
            // THE CARD, as the desktop draws it: three lines, each answering
            // a different question.
            //   project + status   whose is this, and what is it doing
            //   title              the only thing anyone scans for
            //   branch + provider  where the work lands, and who is doing it
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    if row.session.settledOverride == "active" {
                        Image(systemName: "pin.fill").font(.system(size: 9)).foregroundStyle(Theme.textMuted.opacity(0.7))
                    }
                    // The attention and pinned bands, search and the shelves
                    // mix projects, so the row names its own. A row under its
                    // project's own header says nothing the header has not.
                    if showsProject, let project = inbox.project(row) {
                        ProjectAvatar(name: project.name, projectId: project.id, hostId: row.hostId, icon: project.icon, api: settings.api(for: row.hostId), size: 12)
                        Text(project.name).font(.caption2).foregroundStyle(Theme.textMuted.opacity(0.75)).lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    if settings.hosts.count > 1 {
                        Text(hostName(row.hostId)).font(.system(size: 10)).foregroundStyle(Theme.textMuted.opacity(0.7))
                            .padding(.horizontal, 4).background(Theme.subtle, in: RoundedRectangle(cornerRadius: 3))
                    }
                    // THE STATUS SITS WHERE THE TIMESTAMP WOULD, never beside
                    // it: a row showing "Working" and "8h ago" invites the
                    // question of which one is now.
                    statusSlot(row.session)
                }
                HStack(spacing: 6) {
                    // ONE LINE. The title carries the card and is a size up
                    // from the lines around it; a second line makes the card a
                    // paragraph and pushes every row below it around.
                    Text(row.session.title.isEmpty ? "Untitled session" : row.session.title)
                        .font(Theme.rowTitle).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 0)
                    // The provider mark is IDENTITY, not status, so it rides
                    // at the end at reduced opacity. It sits on the title line
                    // so it survives the third line's absence.
                    if row.session.workspace.branch == nil {
                        ProviderIconView(driver: row.session.driver, size: 11).opacity(0.5)
                    }
                }
                // NO THIRD LINE UNLESS IT SAYS SOMETHING THIS ROW ALONE WOULD
                // SAY. A branch differs per row; the model does not.
                if let branch = row.session.workspace.branch {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.triangle.branch").font(.system(size: 9))
                        Text(branch).font(.system(size: 11)).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 4)
                        ProviderIconView(driver: row.session.driver, size: 11).opacity(0.6)
                    }
                    .foregroundStyle(Theme.textMuted.opacity(0.7))
                }
            }
            .padding(.vertical, 4)
            .opacity(inbox.staleHosts.contains(row.hostId) ? 0.6 : 1)
        }
        // MAIL'S GRAMMAR: the leading edge is the one-tap toggle you reach
        // for most (pin), the trailing edge is where a row LEAVES the list
        // (settle, snooze). Full swipe commits the first action on each edge.
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if row.session.settledOverride == "active" {
                Button { Task { await patch(row, SessionPatch(clearSettledOverride: true)) } } label: { Label("Unpin", systemImage: "pin.slash") }
                    .tint(Theme.textMuted)
            } else {
                Button { Task { await patch(row, SessionPatch(settledOverride: "active")) } } label: { Label("Pin", systemImage: "pin") }
                    .tint(Theme.accent)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if isShelved(row) {
                Button { Task { await patch(row, SessionPatch(settledOverride: "active", clearSnooze: true)) } } label: { Label("Wake", systemImage: "arrow.uturn.backward") }
                    .tint(Theme.statusSky)
            } else {
                Button { Task { await inbox.setSettled(row.id, true) } } label: { Label("Settle", systemImage: "checkmark") }
                    .tint(Theme.textTertiary)
                Button { snoozing = row } label: { Label("Snooze", systemImage: "moon.zzz") }
                    .tint(Theme.statusAmber)
            }
        }
        .contextMenu {
            if row.session.settledOverride == "active" {
                Button("Unpin", systemImage: "pin.slash") { Task { await patch(row, SessionPatch(clearSettledOverride: true)) } }
            } else {
                Button("Pin", systemImage: "pin") { Task { await patch(row, SessionPatch(settledOverride: "active")) } }
            }
            if isShelved(row) {
                Button("Wake now", systemImage: "arrow.uturn.backward") { Task { await patch(row, SessionPatch(settledOverride: "active", clearSnooze: true)) } }
            } else {
                Menu("Snooze", systemImage: "moon.zzz") {
                    ForEach(snoozePresets(now: Date())) { preset in
                        Button { Task { await patch(row, SessionPatch(snoozedUntil: preset.until)) } } label: {
                            Text("\(preset.label) · \(preset.when)")
                        }
                    }
                }
                Button("Settle", systemImage: "checkmark") { Task { await inbox.setSettled(row.id, true) } }
            }
            if let base = settings.host(row.hostId)?.baseURL {
                ShareLink(item: row.session.cockpitURL(base: base)) { Label("Share cockpit link", systemImage: "link") }
            }
        }
    }

    /// A SPINNER-DOT FOR "STILL GOING", A STILL DOT FOR "STOPPED AND WAITING",
    /// the wake time for a snoozed row, the relative time for everything else.
    @ViewBuilder private func statusSlot(_ session: Session) -> some View {
        let now = Timestamp(Date().timeIntervalSince1970 * 1000)
        if let until = session.snoozedUntil, until > now, session.activity != .blocked {
            HStack(spacing: 3) {
                Image(systemName: "alarm").font(.system(size: 9))
                Text(relativeTime(until)).monospacedDigit()
            }
            .font(.caption2).foregroundStyle(Theme.textMuted.opacity(0.7))
        } else if session.activity == .blocked {
            HStack(spacing: 3) {
                Image(systemName: "circle.circle").font(.system(size: 9))
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

    /// On the Snoozed or Settled shelf: the trailing action brings it back
    /// rather than pushing it further away.
    private func isShelved(_ row: HostedSession) -> Bool {
        inbox.sections.snoozed.contains { $0.id == row.id } || inbox.sections.settled.contains { $0.id == row.id }
    }

    /// The snooze choices, as a sheet — a swipe cannot open a submenu, and
    /// a single fixed hour was the whole reason the web grew presets.
    @ViewBuilder private func snoozeSheet(_ row: HostedSession) -> some View {
        NavigationStack {
            List(snoozePresets(now: Date())) { preset in
                Button {
                    snoozing = nil
                    Task { await patch(row, SessionPatch(snoozedUntil: preset.until)) }
                } label: {
                    HStack {
                        Text(preset.label).foregroundStyle(Theme.text)
                        Spacer()
                        Text(preset.when).foregroundStyle(Theme.textMuted).monospacedDigit()
                    }
                }
            }
            .navigationTitle("Snooze")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { snoozing = nil } } }
        }
        .presentationDetents([.medium])
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
