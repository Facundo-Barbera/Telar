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
                // A SEARCH RESULT IS ALREADY THE ANSWER to a question you
                // asked, so every row in it is equally relevant and density
                // beats detail — the desktop's rule, same reason.
                ForEach(all.filter(matches)) { row in sessionRow(row, variant: .slim) }
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
                let attention = model.attention.filter(matches)
                if !attention.isEmpty {
                    Section {
                        ForEach(attention) { row in sessionRow(row) }
                    } header: {
                        // NOT `Section("Needs you")`. A plain string header is
                        // the system's generic caption, and this is the one
                        // band on the rail that is ASKING FOR SOMETHING — the
                        // desktop gives it a dot and a count for exactly that
                        // reason (app-sidebar.tsx). The dot says "this band is
                        // different" before the word is read, and the count
                        // says how much of it there is without opening it.
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
                if !model.pinned.filter(matches).isEmpty {
                    Section {
                        ForEach(model.pinned.filter(matches)) { row in sessionRow(row) }
                    }
                }
                ForEach(model.projects.filter { projectFilter == nil || $0.id == projectFilter }) { group in
                    Section {
                        if !collapsed.contains(group.id) {
                            // SLIM: the header above already names the project,
                            // and a card's status and branch lines are mostly
                            // empty on an idle row — so the card was spending
                            // three lines to restate the header.
                            ForEach(group.sessions) { row in sessionRow(row, variant: .slim) }
                        }
                    } header: {
                        Button {
                            if collapsed.contains(group.id) { collapsed.remove(group.id) } else { collapsed.insert(group.id) }
                            savedCollapsed = collapsed.sorted().joined(separator: "\n")
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: collapsed.contains(group.id) ? "chevron.right" : "chevron.down")
                                    .font(.caption).foregroundStyle(Theme.textMuted)
                                ProjectAvatar(name: group.name, projectId: group.projectId, hostId: group.hostId, icon: group.icon, api: settings.api(for: group.hostId), size: 16)
                                // A HEADER IS A HEADER BY ITS WEIGHT. In
                                // `textMuted` at body size this named the
                                // project more quietly than the rows it was
                                // heading, so a group read as a list with a
                                // label rather than as a project with its
                                // conversations under it. The desktop's ratio
                                // (project-group.tsx) is the row's own size at
                                // semibold, near-full strength.
                                Text(group.name).font(Theme.groupHeader).foregroundStyle(Theme.text.opacity(0.9))
                                    .lineLimit(1).truncationMode(.tail)
                                if settings.hosts.count > 1 {
                                    Text(hostName(group.hostId)).font(Theme.metaSmall).foregroundStyle(Theme.textMuted)
                                        .lineLimit(1).padding(.horizontal, 4)
                                        .background(Theme.subtle, in: RoundedRectangle(cornerRadius: 3))
                                }
                                Spacer(minLength: 4)
                                // HOW MANY ARE IN HERE, which a collapsed group
                                // otherwise cannot say at all — and which an
                                // open one still answers without counting rows.
                                Text("\(group.sessions.count)").font(Theme.metaSmall).foregroundStyle(Theme.textMuted).monospacedDigit()
                            }
                        }
                        .accessibilityLabel("\(group.name), \(group.sessions.count) shown, \(collapsed.contains(group.id) ? "collapsed" : "expanded")")
                        .contextMenu {
                            // THE DESKTOP'S HOVER "+", WHICH TOUCH HAS NO ROOM
                            // FOR. A pointer can reveal a control on approach
                            // and give the space back; a finger cannot hover,
                            // so a permanent button would cost every header a
                            // slot to serve the rare press. The long-press menu
                            // is where this platform already keeps a row's
                            // secondary verbs, so it goes there — the
                            // affordance differs because the input does, the
                            // action is the same one.
                            Button("New conversation", systemImage: "square.and.pencil") {
                                resumeDraft(MobileDraft(hostId: group.hostId,
                                                        project: ProjectRef(id: group.projectId, name: group.name, icon: group.icon),
                                                        prompt: "", title: ""))
                            }
                            Divider()
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
        // ONE LIST STYLE, SO THERE IS ONE SIDEBAR.
        //
        // `.sidebar` is not a look, it is TWO looks: in a compact width it
        // falls back to inset-grouped, and in the split view's sidebar column
        // it renders flat. So the phone drew every band as its own rounded card
        // — the pinned pair as one card with a hairline between the rows, each
        // project group as a card, the Settled shelf as a card — while the iPad
        // drew the same rows directly on the column with SPACING as the only
        // grouping cue. Same file, same sections, two different products, and
        // the reported preference was for the phone's: a card is a visible
        // boundary, and a gap is a boundary you have to infer.
        //
        // `.insetGrouped` renders the same at both widths, so the cards are now
        // the grouping cue everywhere. Nothing about the CONTENT changes: the
        // section spacing, the 30pt row floor, and the card/slim row variants
        // are all untouched — this only decides what encloses them.
        .listStyle(.insetGrouped)
        .listSectionSpacing(12)
        // A ONE-LINE ROW CANNOT BE ONE LINE TALL while the list floors every
        // row at the standard 44pt touch target. The slim rows are the whole
        // point of the two volumes, so the floor comes down to meet them; a
        // card is taller than either number and is unaffected, and a row is
        // still a comfortable tap because its content is a full line of text
        // plus the list's own padding.
        .environment(\.defaultMinListRowHeight, 30)
        // THE PAGE STAYS OURS AT BOTH WIDTHS, and that is a deliberate choice
        // against letting the iPad's floating sidebar panel show its own
        // material through.
        //
        // A card reads as a card because of what is BEHIND it. On the phone
        // that is `Theme.sheet` with the system's grouped-secondary fill on top
        // — a fixed, known contrast, in both appearances. The panel's material
        // is translucent and takes its colour from whatever the window happens
        // to be showing underneath, so the same card would separate cleanly
        // over a dark transcript and nearly vanish over a light one. Trading a
        // dependable boundary for a prettier backdrop is the wrong way round
        // when the boundary is the entire point of this change.
        //
        // `scrollContentBackground(.hidden)` hides the SCROLL VIEW's fill only;
        // the cells keep the system's grouped-secondary background, which is
        // why the cards still look like system cards rather than like our
        // colour twice.
        .scrollContentBackground(.hidden)
        .background(Theme.sheet)
        .navigationTitle("Telar")
        // LARGE AT BOTH WIDTHS. The sidebar column defaults to an inline title,
        // which is what put "Telar" on the same line as the two toolbar buttons
        // on the iPad and left the search field to collapse into the bar beside
        // them. Asking for the large title gives the phone's arrangement back:
        // the buttons on their own row, the title under them, and — because a
        // navigation-bar DRAWER is a drawer under the title rather than a slot
        // inside the bar — the search field under that.
        .navigationBarTitleDisplayMode(.large)
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

    /// HOW MUCH ROOM A ROW HAS EARNED — the desktop's `variant: "card" |
    /// "slim"` (apps/web/components/session/session-row.tsx), ported because
    /// the phone only ever drew the card.
    ///
    /// THE SPLIT IS THE WHOLE POINT. A card costs three lines, and three lines
    /// under a project header is the same volume as the header itself — which
    /// is exactly how the iPad's list stopped reading as "section, then the
    /// conversations in it" and started reading as a stack of sections. A
    /// session in a project group, on a shelf, or in a search result is one
    /// line that gives its space back; the bands that are ASKING FOR SOMETHING
    /// — pinned, and "Needs you" — keep the card.
    private enum RowVariant { case card, slim }

    /// THE DISCLOSURE CHEVRON IS THE SYSTEM'S CALL, and is left to it.
    ///
    /// A `NavigationLink` in a compact width PUSHES, so it gets the chevron
    /// that says so; in the split view's sidebar column the same link SELECTS,
    /// and the row that is selected stays highlighted. Those are different
    /// promises, and drawing a push affordance next to a row that does not push
    /// would be the one place this file lied about what a tap does. The two
    /// widths look alike everywhere it is a matter of taste; here it is a
    /// matter of fact, so they are allowed to differ.
    private func sessionRow(_ row: HostedSession, variant: RowVariant = .card, showsProject: Bool = true) -> some View {
        NavigationLink(value: row.id) {
            Group {
                switch variant {
                case .card: cardBody(row, showsProject: showsProject)
                case .slim: slimBody(row)
                }
            }
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

    /// THE CARD, as the desktop draws it: three lines, each answering a
    /// different question.
    ///   project + status   whose is this, and what is it doing
    ///   title              the only thing anyone scans for
    ///   branch + provider  where the work lands, and who is doing it
    @ViewBuilder private func cardBody(_ row: HostedSession, showsProject: Bool) -> some View {
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
                unreadDot(row.session)
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
    }

    /// THE SLIM ROW: one line, and it gives its space back.
    ///
    /// Three things go, and each of them was costing a line for something the
    /// reader was not asking this row: the project NAME (a row in a project
    /// group sits under a header that already says it, and on a shelf the mark
    /// alone answers "whose"), the branch, and the second provider mark. What
    /// is left is the desktop's own slim body — a mark, the title, and the one
    /// right-hand slot that is either a status or an age.
    ///
    /// THE MARK IS THE PROJECT'S WHERE THERE IS ONE, as on the desktop: whose
    /// work this is cannot be read off a title, and under a project header the
    /// mark doubles as the indent that puts the row below its header. The
    /// provider is identity that the card already carries, so it is only the
    /// fallback for an orphan session with no project.
    @ViewBuilder private func slimBody(_ row: HostedSession) -> some View {
        HStack(spacing: 6) {
            if row.session.settledOverride == "active" {
                Image(systemName: "pin.fill").font(.system(size: 8)).foregroundStyle(Theme.textMuted.opacity(0.7))
            }
            if let project = inbox.project(row) {
                ProjectAvatar(name: project.name, projectId: project.id, hostId: row.hostId, icon: project.icon, api: settings.api(for: row.hostId), size: 13)
                    .opacity(0.8)
            } else {
                ProviderIconView(driver: row.session.driver, size: 12).opacity(0.6)
            }
            unreadDot(row.session)
            Text(row.session.title.isEmpty ? "Untitled session" : row.session.title)
                // A SLIM ROW DIMS ITS TITLE AT REST, which would read as "less
                // important" on the one row that is asking to be opened. An
                // unread row keeps its full weight, so the dot and the title
                // agree.
                .font(Settling.showsUnreadMark(row.session) ? Theme.rowTitleSlim.weight(.medium) : Theme.rowTitleSlim)
                .foregroundStyle(Settling.showsUnreadMark(row.session) ? Theme.text : Theme.text.opacity(0.85))
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            statusSlot(row.session)
        }
    }

    /// THERE IS AN ANSWER HERE NOBODY HAS READ — the mail convention, and
    /// deliberately the whole of it.
    ///
    /// A FILLED DOT AT THE LEADING EDGE OF THE TITLE, no counter. A count would
    /// be a number you audit ("three unread what?"), and the engine models one
    /// bit: is the newest result newer than the newest receipt. The dot is that
    /// bit, in the place every mail app has put it for thirty years, so it
    /// needs no explaining.
    ///
    /// IT GOES AWAY BY ITSELF. Nothing in this sidebar clears it — opening the
    /// session and actually seeing the answer does (Stores/ReadReceipt.swift),
    /// the Mac moves `lastReadTurnSequence`, and the next poll draws a row with
    /// no dot. Which is why this is a mark and not a button: "mark read" is
    /// what you offer when reading does not count, and here it does.
    @ViewBuilder private func unreadDot(_ session: Session) -> some View {
        if Settling.showsUnreadMark(session) {
            Circle().fill(Theme.accent).frame(width: 6, height: 6)
                .accessibilityLabel("Unread answer")
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
                    // A SHELF IS OFF THE LIST — history behind you, or work
                    // deferred ahead of you — so its rows give their space
                    // back, one line each.
                    ForEach(filtered.prefix(settledLimit)) { row in sessionRow(row, variant: .slim) }
                    if filtered.count > settledLimit { Button("Show more") { settledLimit += 25 } }
                }
            } header: {
                // THE DESKTOP'S `BandRule` (app-sidebar.tsx): chevron, the
                // band's name as a CAPTION, a hairline that runs out to the
                // count. The line is the point — a shelf divides what is above
                // it from what it holds, and sentence-case text with a gap
                // where the rule should be was the same control drawn as a
                // plain row. The rule is drawn rather than left to the list's
                // own separator because a section header in an inset-grouped
                // list sits OUTSIDE the card, on the page, where the list draws
                // no separator at all.
                Button { open.wrappedValue.toggle() } label: {
                    HStack(spacing: 6) {
                        Image(systemName: open.wrappedValue ? "chevron.down" : "chevron.right")
                            .font(.caption)
                        Text(name)
                        Rectangle().fill(Theme.border).frame(height: 1).accessibilityHidden(true)
                        Text("\(filtered.count)").monospacedDigit()
                    }
                    .bandCaption()
                }
                .accessibilityLabel("\(name), \(filtered.count), \(open.wrappedValue ? "expanded" : "collapsed")")
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
