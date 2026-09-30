import SwiftUI

struct SessionSidebar: View {
    let settings: AppSettings
    let inbox: MergedInbox
    @Binding var selection: ScopedSessionID?
    let newSession: () -> Void
    let openSettings: () -> Void
    let resumeDraft: (MobileDraft) -> Void
    @State private var query = ""
    @State private var collapsed: Set<String> = []
    @State private var snoozedOpen = false
    @State private var settledOpen = false
    @State private var settledLimit = 25
    @State private var layoutError: String?

    @State private var addingTo: AddProjectTarget?
    @State private var showUsage = false

    @State private var snoozing: HostedSession?

    @State private var renaming: HostedSession?
    @State private var renameDraft = ""

    @State private var deleting: HostedSession?
    @AppStorage("telar.sidebar.collapsed") private var savedCollapsed = ""
    @AppStorage("telar.sidebar.expandedParents") private var savedExpanded = ""

    @ScaledMetric(relativeTo: .footnote) private var groupMark: CGFloat = 16
    @ScaledMetric(relativeTo: .caption2) private var rowProjectMark: CGFloat = 12
    @ScaledMetric(relativeTo: .subheadline) private var titleProviderMark: CGFloat = 11
    @ScaledMetric(relativeTo: .caption) private var branchProviderMark: CGFloat = 11

    @ScaledMetric(relativeTo: .footnote) private var slimProjectMark: CGFloat = 13
    @ScaledMetric(relativeTo: .footnote) private var slimProviderMark: CGFloat = 12

    private var model: SidebarModel {
        SidebarModel(
            sessions: inbox.sections.active,
            names: inbox.projectName,
            marks: { inbox.project($0)?.mark ?? .none },
            remotes: { inbox.project($0)?.remoteUrl },
            hostNames: { settings.host($0)?.name },

            availabilities: { inbox.project($0)?.availability },
            layouts: inbox.layouts
        )
    }
    private var all: [HostedSession] { inbox.sections.active + inbox.sections.tail }
    private func matches(_ row: HostedSession) -> Bool {
        query.isEmpty || [row.session.title, inbox.projectName(row) ?? "", settings.host(row.hostId)?.name ?? ""]
            .contains { $0.localizedStandardContains(query) }
    }

    var body: some View {
        lifecycle
            .sheet(item: $snoozing) { row in snoozeSheet(row) }

            .alert("Rename session", isPresented: presenting($renaming)) {
                TextField("Title", text: $renameDraft)
                Button("Rename") {
                    guard let row = renaming else { return }
                    let title = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                    renaming = nil
                    guard !title.isEmpty, title != row.session.title else { return }
                    Task { await patch(row, SessionPatch(title: title)) }
                }
                Button("Cancel", role: .cancel) { renaming = nil }
            }

            .confirmationDialog(
                deleting.map { "Delete “\($0.session.title.isEmpty ? "Untitled session" : $0.session.title)”?" } ?? "Delete session?",
                isPresented: presenting($deleting),
                titleVisibility: .visible
            ) {
                Button("Delete session", role: .destructive) {
                    guard let row = deleting else { return }
                    deleting = nil
                    Task { await remove(row) }
                }
                Button("Cancel", role: .cancel) { deleting = nil }
            } message: {
                Text("The conversation and everything it holds go with it. This cannot be undone.")
            }
    }

    private var lifecycle: some View {
        presentations

            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 0) {
                    Button(action: openSettings) {
                        Image(systemName: "gearshape")
                            .scaledGlyphBox(44, glyph: 17).contentShape(Rectangle())
                    }
                    .keyboardShortcut(",", modifiers: .command)
                    .accessibilityLabel("Settings")
                    Button { showUsage = true } label: {
                        Image(systemName: "chart.bar")
                            .scaledGlyphBox(44, glyph: 17).contentShape(Rectangle())
                    }
                    .accessibilityLabel("Usage")
                    .disabled(settings.hosts.isEmpty)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Theme.textMuted)
                .padding(.horizontal, 8)
                .background(Theme.sheet)
            }

            .refreshable { await inbox.refresh() }
            .task {
                collapsed = Set(savedCollapsed.split(separator: "\n").map(String.init))
            }
    }

    private var presentations: some View {
        navigation

            .sheet(item: $addingTo) { target in
                NavigationStack {
                    AddProjectView(api: target.api) { _ in
                        addingTo = nil
                        Task { await inbox.refresh() }
                    }
                    .navigationTitle("Add project")
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { addingTo = nil } } }
                }
            }
            .sheet(isPresented: $showUsage) {
                NavigationStack {
                    UsageView(settings: settings, hostId: inbox.filter ?? settings.hosts.first?.id)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showUsage = false } } }
                }
            }
    }

    private var navigation: some View {
        chrome
            .navigationTitle("Telar")

            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search sessions, projects, Macs")

            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    addProject
                    Button("New conversation", systemImage: "square.and.pencil", action: newSession).keyboardShortcut("n", modifiers: .command)
                }
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Picker("Mac", selection: Bindable(inbox).filter) {
                            Text("All Macs").tag(nil as HostID?)
                            ForEach(settings.hosts) { Text($0.name).tag(Optional($0.id)) }
                        }
                    } label: { Label(inbox.filter.map(hostName) ?? "All Macs", systemImage: "line.3.horizontal.decrease") }
                }
            }
    }

    private var chrome: some View {
        sessionList

            .listStyle(.insetGrouped)
            .listSectionSpacing(12)

            .environment(\.defaultMinListRowHeight, 30)

            .scrollContentBackground(.hidden)
            .background(Theme.sheet)
    }

    private var sessionList: some View {
        List(selection: $selection) {
            failureBanners
            layoutErrorLine
            if !query.isEmpty {
                let found = all.filter(matches)

                ForEach(found) { row in sessionRow(row, variant: .slim) }

                if found.isEmpty {
                    ContentUnavailableView("No sessions found", systemImage: "text.bubble", description: Text("Try another title or project."))
                }
            } else {
                draftRows
                attentionBand
                if SessionNesting.isFlat(inbox.filter.map { [inbox.layout($0)] } ?? Array(inbox.layouts.values)) {
                    flatBands
                } else {
                    pinnedBand
                    projectBands
                }
                shelf("Snoozed", rows: inbox.sections.snoozed.sorted { ($0.session.snoozedUntil ?? 0) < ($1.session.snoozedUntil ?? 0) }, open: $snoozedOpen)

                shelf(
                    "Settled",
                    rows: inbox.sections.settled,
                    open: $settledOpen,
                    heldBack: inbox.shelvedOnMacs,
                    onOpen: { await inbox.showSettled() }
                )
            }
            emptyState
        }
    }

    private var failureBanners: some View {
        ForEach(inbox.failures) { failure in
            Label(failure.needsPairing ? "\(hostName(failure.hostId)) needs pairing" : "\(hostName(failure.hostId)) is offline · showing saved sessions", systemImage: failure.needsPairing ? "lock" : "wifi.slash")
                .font(.caption).foregroundStyle(Theme.statusAmber)
        }
    }

    @ViewBuilder
    private var layoutErrorLine: some View {
        if let layoutError { Text(layoutError).font(.caption).foregroundStyle(Theme.statusRed) }
    }

    @ViewBuilder
    private var draftRows: some View {
        ForEach(MobileDrafts.shared.drafts.filter { draft in
            settings.host(draft.hostId) != nil && (inbox.filter == nil || inbox.filter == draft.hostId)
        }) { draft in
            Button { resumeDraft(draft) } label: {
                Label(String(draft.prompt.prefix(60)), systemImage: "pencil")
                    .font(.subheadline).lineLimit(1)
            }.contextMenu {
                Button("Discard draft", role: .destructive) { MobileDrafts.shared.remove(host: draft.hostId, project: draft.project.id) }
            }
        }
    }

    @ViewBuilder
    private var attentionBand: some View {
        let attention = model.attention.filter(matches)
        if !attention.isEmpty {
            Section {
                ForEach(attention) { row in sessionRow(row) }
            } header: {
                HStack(spacing: 6) {
                    Circle().fill(Theme.statusRed).frame(width: 6, height: 6)
                    Text("Needs you")
                    Spacer(minLength: 4)
                    Text("\(attention.count)").monospacedDigit()
                }
                .bandCaption()
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Needs you, \(attention.count)")
            }
        }
    }

    @ViewBuilder
    private var pinnedBand: some View {
        let pinnedRows = model.pinned.filter(matches)
        if !pinnedRows.isEmpty {
            Section {
                ForEach(pinnedRows) { row in sessionRow(row) }
                    .onMove { offsets, destination in
                        Task { await reorder(pinnedRows, offsets: offsets, to: destination, key: .pinned) }
                    }
            }
        }
    }

    @ViewBuilder
    private var projectBands: some View {
        ForEach(model.projects) { group in
            Section {
                if !collapsed.contains(group.id) {
                    let drawn = group.sessions

                    ForEach(drawn) { row in sessionRow(row, variant: .slim, placesAbove: group.places.count) }
                        .onMove { offsets, destination in
                            Task { await reorder(drawn, offsets: offsets, to: destination, key: .group(group.layoutKey)) }
                        }
                }
            } header: {
                Button {
                    if collapsed.contains(group.id) { collapsed.remove(group.id) } else { collapsed.insert(group.id) }
                    savedCollapsed = collapsed.sorted().joined(separator: "\n")
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: collapsed.contains(group.id) ? "chevron.right" : "chevron.down")
                            .font(.caption).foregroundStyle(Theme.textMuted)
                        ProjectAvatar(name: group.name, projectId: group.projectId, hostId: group.hostId, mark: group.mark, api: settings.api(for: group.hostId), size: groupMark)

                        Text(group.name).font(Theme.groupHeader).foregroundStyle(Theme.text.opacity(0.9))
                            .lineLimit(1).truncationMode(.tail)

                        if let away = group.awayLabel {
                            Text(away).font(Theme.metaSmall).foregroundStyle(Theme.textMuted)
                                .lineLimit(1).padding(.horizontal, 4)
                                .background(Theme.subtle, in: RoundedRectangle(cornerRadius: 3))
                        }

                        if group.places.count > 1 || settings.hosts.count > 1 {
                            ForEach(group.places) { place in
                                Text(hostName(place.hostId)).font(Theme.metaSmall).foregroundStyle(Theme.textMuted)
                                    .lineLimit(1).padding(.horizontal, 4)
                                    .background(Theme.subtle, in: RoundedRectangle(cornerRadius: 3))
                            }
                        }
                        Spacer(minLength: 4)

                        Text("\(group.sessions.count)").font(Theme.metaSmall).foregroundStyle(Theme.textMuted).monospacedDigit()
                    }
                }
                .accessibilityLabel("\(group.name), \(group.sessions.count) shown, \(collapsed.contains(group.id) ? "collapsed" : "expanded")")
                .contextMenu {
                    newConversation(group)
                    Divider()

                    Button(collapsed.contains(group.id) ? "Expand" : "Collapse",
                           systemImage: collapsed.contains(group.id) ? "chevron.down" : "chevron.right") {
                        setCollapsed(collapsed.symmetricDifference([group.id]))
                    }
                    Button("Collapse others", systemImage: "arrow.down.right.and.arrow.up.left") {
                        setCollapsed(ProjectHeaderMenu.collapseOthers(all: model.projects.map(\.id), keeping: group.id))
                    }
                    Divider()

                    Button("Move up", systemImage: "arrow.up") { Task { await move(group, offset: -1) } }
                    Button("Move down", systemImage: "arrow.down") { Task { await move(group, offset: 1) } }
                }
            }
        }
    }

    @ViewBuilder
    private var flatBands: some View {
        let rail = SessionNesting.flat(model, assignments: inbox.assignments, expanded: expandedParents, selected: selection)
        if !rail.pinned.isEmpty {
            Section {
                ForEach(rail.pinned) { item in
                    sessionRow(item.row, family: item.family, nested: item.nested, outlined: rail.pinned.contains { $0.family != nil })
                        .moveDisabled(item.nested)
                }
                .onMove { offsets, destination in
                    Task { await reorder(rail.pinned.map(\.row), offsets: offsets, to: destination, key: .pinned) }
                }
            }
        }
        if !rail.rows.isEmpty {
            Section {
                ForEach(rail.rows) { item in
                    sessionRow(item.row, variant: .slim, family: item.family, nested: item.nested, outlined: rail.rows.contains { $0.family != nil })
                }
            }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if inbox.loaded && all.isEmpty {
            if inbox.hasProjects {
                ContentUnavailableView("No sessions yet", systemImage: "text.bubble", description: Text("Start one from the button above."))
            } else {
                ContentUnavailableView("No projects yet", systemImage: "folder.badge.plus", description: Text("Register a project to start a session."))
            }
        }
    }

    private var expandedParents: Set<String> { Set(savedExpanded.split(separator: "\n").map(String.init)) }

    @ViewBuilder private func familyToggle(_ family: SessionFamily?) -> some View {
        if let family {
            let key = SessionNesting.foldKey(family.parent.id)
            SessionFamilyToggle(family: family, open: expandedParents.contains(key)) {
                savedExpanded = expandedParents.symmetricDifference([key]).sorted().joined(separator: "\n")
            }
        }
    }

    private func presenting<T>(_ subject: Binding<T?>) -> Binding<Bool> {
        Binding(get: { subject.wrappedValue != nil }, set: { if !$0 { subject.wrappedValue = nil } })
    }

    private func hostName(_ id: HostID) -> String { HostLabel.name(settings.host(id)?.name) }

    private struct AddProjectTarget: Identifiable {
        let hostId: HostID
        let api: any EngineAPI
        var id: HostID { hostId }
    }

    private var addProjectHosts: [Host] {
        settings.hosts.filter { settings.api(for: $0.id) != nil && (inbox.filter == nil || inbox.filter == $0.id) }
    }

    @ViewBuilder private var addProject: some View {
        let hosts = addProjectHosts
        if hosts.count == 1, let host = hosts.first, let api = settings.api(for: host.id) {
            Button("Add project", systemImage: "folder.badge.plus") {
                addingTo = AddProjectTarget(hostId: host.id, api: api)
            }
        } else if !hosts.isEmpty {
            Menu("Add project", systemImage: "folder.badge.plus") {
                ForEach(hosts) { host in
                    Button(host.name, systemImage: "desktopcomputer") {
                        guard let api = settings.api(for: host.id) else { return }
                        addingTo = AddProjectTarget(hostId: host.id, api: api)
                    }
                }
            }
        }
    }

    @ViewBuilder private func newConversation(_ group: SidebarProject) -> some View {
        if group.places.count > 1 {
            Menu("New conversation here", systemImage: "square.and.pencil") {
                ForEach(group.places) { place in
                    Button(hostName(place.hostId), systemImage: "desktopcomputer") { startDraft(place) }
                }
            }
        } else {
            Button("New conversation here", systemImage: "square.and.pencil") {
                startDraft(group.places.first ?? ProjectPlace(hostId: group.hostId, projectId: group.projectId, name: group.name, mark: group.mark))
            }
        }
    }

    private func startDraft(_ place: ProjectPlace) {
        resumeDraft(MobileDraft(hostId: place.hostId,
                                project: ProjectRef(id: place.projectId, name: place.name, icon: place.mark.icon,
                                                    iconName: place.mark.iconName, iconEmoji: place.mark.iconEmoji),
                                prompt: ""))
    }

    private enum RowVariant { case card, slim }

    private func sessionRow(
        _ row: HostedSession, variant: RowVariant = .card, showsProject: Bool = true, placesAbove: Int = 0,
        family: SessionFamily? = nil, nested: Bool = false, outlined: Bool = false
    ) -> some View {
        let host = HostLabel.row(
            name: settings.host(row.hostId)?.name, hostCount: settings.hosts.count, placesAbove: placesAbove
        )
        return NavigationLink(value: row.id) {
            HStack(spacing: 4) {
                if outlined && !nested { familyToggle(family).frame(width: 18) }
                if nested {
                    SessionChildRow(session: row.session)
                } else {
                    switch variant {
                    case .card: cardBody(row, showsProject: showsProject, host: host)
                    case .slim: slimBody(row, host: host)
                    }
                }
            }
            .padding(.leading, nested ? 22 : 0)
            .opacity(inbox.staleHosts.contains(row.hostId) ? 0.6 : 1)

            .overlay(alignment: .leading) {
                if variant == .card, let tone = accentTone(row.session) {
                    Capsule().fill(tone).frame(width: 2).padding(.vertical, 2).offset(x: -8)
                }
            }
        }

        .accessibilityHint(settledHint(row).map(Text.init) ?? Text(""))

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
                    .tint(Theme.textMuted)
                Button { snoozing = row } label: { Label("Snooze", systemImage: "moon.zzz") }
                    .tint(Theme.statusAmber)
            }
        }
        .contextMenu {
            ForEach(menuItems(row)) { item in
                if let children = item.children {
                    Menu(item.label, systemImage: item.systemImage) {
                        ForEach(children) { child in menuButton(child, on: row) }
                    }
                    .disabled(item.disabled != nil)
                } else {
                    menuButton(item, on: row)
                }
            }
        }
    }

    private func menuItems(_ row: HostedSession) -> [SessionMenuItem] {
        SessionRowMenu.items(
            session: row.session,
            projectName: inbox.projectName(row),
            settled: inbox.sections.settled.contains { $0.id == row.id } || row.session.settledOverride == "settled",
            cockpitURL: settings.host(row.hostId)?.baseURL.map { row.session.cockpitURL(base: $0) },
            now: Date()
        )
    }

    @ViewBuilder private func menuButton(_ item: SessionMenuItem, on row: HostedSession) -> some View {
        Button(role: item.destructive ? .destructive : nil) {
            run(item.verb, on: row)
        } label: {
            Label(item.detail.map { "\(item.label) · \($0)" } ?? item.label, systemImage: item.systemImage)
        }
        .disabled(item.disabled != nil)
    }

    private func run(_ verb: SessionMenuVerb?, on row: HostedSession) {
        switch verb {
        case .newSession(let projectId, let baseRef):
            let project = inbox.project(row)
                ?? ProjectRef(id: projectId, name: inbox.projectName(row) ?? "Project")
            resumeDraft(MobileDraft(hostId: row.hostId, project: project, prompt: "", baseRef: baseRef))
        case .pin(let pinned):
            Task { await patch(row, pinned ? SessionPatch(settledOverride: "active") : SessionPatch(clearSettledOverride: true)) }
        case .settle(let settled):
            Task { await inbox.setSettled(row.id, settled) }
        case .snooze(let until):

            Task { await patch(row, until.map { SessionPatch(snoozedUntil: $0) } ?? SessionPatch(settledOverride: "active", clearSnooze: true)) }
        case .rename:
            renameDraft = row.session.title
            renaming = row
        case .regenerateTitle:
            Task { await regenerateTitle(row) }
        case .copy(let text):
            UIPasteboard.general.string = text
        case .delete:
            deleting = row
        case nil:
            break
        }
    }

    @ViewBuilder private func cardBody(_ row: HostedSession, showsProject: Bool, host: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                if row.session.settledOverride == "active" {
                    Image(systemName: "pin.fill").font(.system(Theme.captionTiny)).foregroundStyle(Theme.textMuted.opacity(0.7))
                }

                if showsProject, let project = inbox.project(row) {
                    ProjectAvatar(name: project.name, projectId: project.id, hostId: row.hostId, mark: project.mark, api: settings.api(for: row.hostId), size: rowProjectMark)
                    Text(project.name).font(.caption2).foregroundStyle(Theme.textMuted.opacity(0.75)).lineLimit(1)
                }
                Spacer(minLength: 4)
                if let host { hostBadge(host) }

                SessionStatusSlot(session: row.session)
            }
            HStack(spacing: 6) {
                UnreadDot(session: row.session)

                Text(row.session.title.isEmpty ? "Untitled session" : row.session.title)
                    .font(Theme.rowTitle).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)

                if row.session.workspace.branch == nil {
                    ProviderIconView(driver: row.session.driver, size: titleProviderMark).opacity(0.5)
                }
            }

            if let branch = row.session.workspace.branch {
                HStack(spacing: 5) {
                    Image(systemName: "arrow.triangle.branch").font(.system(Theme.captionTiny))
                    Text(branch).font(.system(Theme.caption)).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    ProviderIconView(driver: row.session.driver, size: branchProviderMark).opacity(0.6)
                }
                .foregroundStyle(Theme.textMuted.opacity(0.7))
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private func slimBody(_ row: HostedSession, host: String?) -> some View {
        HStack(spacing: 6) {
            if row.session.settledOverride == "active" {
                Image(systemName: "pin.fill").font(.system(Theme.captionTiny)).foregroundStyle(Theme.textMuted.opacity(0.7))
            }
            if let project = inbox.project(row) {
                ProjectAvatar(name: project.name, projectId: project.id, hostId: row.hostId, mark: project.mark, api: settings.api(for: row.hostId), size: slimProjectMark)
                    .opacity(0.8)
            } else {
                ProviderIconView(driver: row.session.driver, size: slimProviderMark).opacity(0.6)
            }
            UnreadDot(session: row.session)
            Text(row.session.title.isEmpty ? "Untitled session" : row.session.title)

                .font(Settling.showsUnreadMark(row.session) ? Theme.rowTitleSlim.weight(.medium) : Theme.rowTitleSlim)
                .foregroundStyle(Settling.showsUnreadMark(row.session) ? Theme.text : Theme.text.opacity(0.7))
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)

            if let host { hostBadge(host) }

            if let hint = settledHint(row), row.session.activity == .idle, row.session.snoozedUntil == nil {
                Text(hint).font(.caption2).foregroundStyle(Theme.textMuted.opacity(0.7))
                    .lineLimit(1).truncationMode(.tail)
                    .layoutPriority(-1)
            } else {
                SessionStatusSlot(session: row.session)
            }
        }
    }

    private func settledHint(_ row: HostedSession) -> String? {
        Settling.settledHint(
            row.session,
            coordinatorTitle: row.session.settledBy.flatMap { inbox.title($0.coordinatorSessionId, on: row.hostId) }
        )
    }

    private func hostBadge(_ name: String) -> some View {
        Text(name).font(.system(Theme.caption)).foregroundStyle(Theme.textMuted.opacity(0.7))
            .lineLimit(1).truncationMode(.tail)
            .padding(.horizontal, 4).background(Theme.subtle, in: RoundedRectangle(cornerRadius: 3))
            .accessibilityLabel("On \(name)")
    }

    private func accentTone(_ session: Session) -> Color? {
        switch session.activity {
        case .blocked: return Theme.statusAmber
        case .working, .queued, .monitoring: return Theme.accent
        case .idle: return nil
        }
    }

    private func isShelved(_ row: HostedSession) -> Bool {
        inbox.sections.snoozed.contains { $0.id == row.id } || inbox.sections.settled.contains { $0.id == row.id }
    }

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

    @ViewBuilder private func shelf(
        _ name: String,
        rows: [HostedSession],
        open: Binding<Bool>,
        heldBack: Int = 0,

        onOpen: (@MainActor () async -> Void)? = nil
    ) -> some View {
        let filtered = rows.filter(matches)

        let count = open.wrappedValue ? filtered.count : max(filtered.count, heldBack)
        if !filtered.isEmpty || heldBack > 0 {
            Section {
                if open.wrappedValue {
                    ForEach(filtered.prefix(settledLimit)) { row in sessionRow(row, variant: .slim) }
                    if filtered.count > settledLimit { Button("Show more") { settledLimit += 25 } }
                }
            } header: {
                Button {
                    let opening = !open.wrappedValue
                    open.wrappedValue = opening

                    if opening, let onOpen { Task { await onOpen() } }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: open.wrappedValue ? "chevron.down" : "chevron.right")
                            .font(.caption)
                        Text(name)
                        Rectangle().fill(Theme.border).frame(height: 1).accessibilityHidden(true)
                        Text("\(count)").monospacedDigit()
                    }
                    .bandCaption()
                }
                .accessibilityLabel("\(name), \(count), \(open.wrappedValue ? "expanded" : "collapsed")")
            }
        }
    }

    private func patch(_ row: HostedSession, _ patch: SessionPatch) async {
        do { try await settings.api(for: row.hostId)?.patchSession(row.session.id, patch: patch); await inbox.refresh() }
        catch { layoutError = error.localizedDescription }
    }

    private func regenerateTitle(_ row: HostedSession) async {
        do { try await settings.api(for: row.hostId)?.regenerateSessionTitle(row.session.id); await inbox.refresh() }
        catch { layoutError = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription }
    }

    private func remove(_ row: HostedSession) async {
        do {
            try await settings.api(for: row.hostId)?.deleteSession(row.session.id)
            if selection == row.id { selection = nil }
            await inbox.refresh()
        } catch {
            layoutError = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func setCollapsed(_ next: Set<String>) {
        collapsed = next
        savedCollapsed = collapsed.sorted().joined(separator: "\n")
    }
    private func move(_ group: SidebarProject, offset: Int) async {
        var drawn = model.projects
        guard let index = drawn.firstIndex(where: { $0.id == group.id }), drawn.indices.contains(index + offset) else { return }
        drawn.swapAt(index, index + offset)
        await saveOrder(drawn)
    }

    private func saveOrder(_ drawn: [SidebarProject]) async {
        var byHost: [HostID: [String]] = [:]
        for group in drawn {
            for place in group.places { byHost[place.hostId, default: []].append(group.layoutKey) }
        }
        for (host, order) in byHost where order != inbox.layout(host).projectOrder.filter(order.contains) {
            await saveOrder(order, host: host)
        }
    }

    private func reorder(_ drawn: [HostedSession], offsets: IndexSet, to destination: Int, key: RowOrderKey) async {
        guard let move = SidebarModel.reordered(drawn, offsets: offsets, to: destination) else { return }
        await saveRowOrder(move.ids, key: key, host: move.host)
    }

    private enum RowOrderKey {
        case pinned
        case group(String)
    }

    private func saveRowOrder(_ ids: [String], key: RowOrderKey, host: HostID) async {
        guard let api = settings.api(for: host) else { return }
        let previous = inbox.layout(host)
        var optimistic = previous
        switch key {
        case .pinned: optimistic.pinnedOrder = ids
        case .group(let group): optimistic.sessionOrder[group] = ids
        }
        inbox.applyLayout(host, optimistic)
        do {
            let current = (try? await api.sidebarLayout()) ?? previous
            switch key {
            case .pinned:
                let order = SidebarModel.keepingUnseen(ids, stored: current.pinnedOrder)
                inbox.applyLayout(host, try await api.setSidebarLayout(pinnedOrder: order))
            case .group(let group):
                var map = current.sessionOrder
                map[group] = SidebarModel.keepingUnseen(ids, stored: current.sessionOrder[group] ?? [])
                inbox.applyLayout(host, try await api.setSidebarLayout(sessionOrder: map))
            }
            layoutError = nil
        } catch {
            inbox.applyLayout(host, previous)
            layoutError = "Couldn't save conversation order. Try again when the Mac is connected."
        }
    }

    private func saveOrder(_ order: [String], host: HostID) async {
        guard let api = settings.api(for: host) else { return }
        let previous = inbox.layout(host)
        inbox.applyLayout(host, SidebarLayout(projectOrder: order, sessionOrder: previous.sessionOrder, pinnedOrder: previous.pinnedOrder, mode: previous.mode))
        do {
            let current = (try? await api.sidebarLayout()) ?? previous

            let rest = current.projectOrder.filter { !order.contains($0) }
            inbox.applyLayout(host, try await api.setSidebarLayout(projectOrder: order + rest))
            layoutError = nil
        } catch {
            inbox.applyLayout(host, previous)
            layoutError = "Couldn't save project order. Try again when the Mac is connected."
        }
    }
}
