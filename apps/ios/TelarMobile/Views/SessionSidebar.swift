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
    @State private var collapsed: Set<String> = []
    @State private var snoozedOpen = false
    @State private var settledOpen = false
    @State private var settledLimit = 25
    @State private var layoutError: String?
    /// The row whose snooze sheet is up.
    @State private var snoozing: HostedSession?
    /// The row being renamed, and the field's text. Two pieces of state
    /// rather than one because the alert's `TextField` needs a binding that
    /// outlives the row's identity check.
    @State private var renaming: HostedSession?
    @State private var renameDraft = ""
    /// The row whose deletion is being confirmed.
    @State private var deleting: HostedSession?
    @AppStorage("telar.sidebar.collapsed") private var savedCollapsed = ""

    private var model: SidebarModel {
        SidebarModel(
            sessions: inbox.sections.active,
            names: inbox.projectName,
            icons: { inbox.project($0)?.icon },
            remotes: { inbox.project($0)?.remoteUrl },
            hostNames: { settings.host($0)?.name },
            layouts: inbox.layouts
        )
    }
    private var all: [HostedSession] { inbox.sections.active + inbox.sections.tail }
    private func matches(_ row: HostedSession) -> Bool {
        // THE FILTER KEYS BY GROUP, NOT BY MAC. Two Macs' checkouts of one
        // repository are one group, so picking that project has to keep both
        // Macs' rows — a `hostId:projectId` key would have kept one of them.
        let key = SidebarModel.groupKey(hostId: row.hostId, projectId: row.session.projectId ?? "", remote: inbox.project(row)?.remoteUrl)
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
                // THE DESKTOP'S WORDS, because a reader who has both open
                // should not have to work out that two different sentences are
                // the same answer (`SidebarEmpty`, app-sidebar.tsx). The detail
                // line is the part that earns its space: it says what to try.
                if all.filter(matches).isEmpty {
                    ContentUnavailableView("No sessions found", systemImage: "text.bubble", description: Text("Try another title or project."))
                }
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
                                // ONE HEADER, EVERY MAC IT LIVES ON — the
                                // desktop's rule (project-group.tsx). A group on
                                // one Mac wears a badge only when there is more
                                // than one Mac to tell apart; the moment a group
                                // SPANS two, both are named regardless, because
                                // then which Mac a row is on is the one thing
                                // the reader cannot infer from the group.
                                if group.places.count > 1 || settings.hosts.count > 1 {
                                    ForEach(group.places) { place in
                                        Text(hostName(place.hostId)).font(Theme.metaSmall).foregroundStyle(Theme.textMuted)
                                            .lineLimit(1).padding(.horizontal, 4)
                                            .background(Theme.subtle, in: RoundedRectangle(cornerRadius: 3))
                                    }
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
                            newConversation(group)
                            Divider()
                            // THE VERB EXISTS, THE MENU JUST DID NOT OFFER IT
                            // (#327). Tapping the header already collapses the
                            // group, so this row is not new capability — it is
                            // the one place a reader who long-pressed can find
                            // out that the gesture exists, and the only way to
                            // reach "Collapse others" at all.
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
                        .draggable(group.id)
                        // A GROUP MAY NOW CROSS A MAC, because the rail is one
                        // arranged list rather than a block per Mac — a merged
                        // group belongs to two of them and cannot sit inside
                        // either block. The drop writes each Mac's own document
                        // from the new drawn order; see `saveOrder`.
                        .dropDestination(for: String.self) { ids, _ in
                            guard let id = ids.first, let source = model.projects.first(where: { $0.id == id }) else { return false }
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
        // AN ICON ROW, NOT A SENTENCE. The desktop's footer
        // (app-sidebar-footer.tsx) is a row of muted glyphs on the left, and
        // that is the right shape for a destination you reach twice a week: a
        // full-width tinted "Settings" was the loudest thing on the rail,
        // reading as the sidebar's primary action directly beneath the work
        // that actually is.
        //
        // ONE GLYPH, BECAUSE THERE IS ONE PAGE. The desktop puts Usage beside
        // it; the phone has no usage screen to open, and a disabled or absent
        // twin would be chrome. The desktop's update control has no counterpart
        // either — this app updates through TestFlight, which is the App
        // Store's job and not a button's.
        //
        // The glyph keeps the web's size and the tap target does not: 32pt is a
        // mouse target, and a finger is owed the full 44.
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 0) {
                Button(action: openSettings) {
                    Image(systemName: "gearshape").font(.system(size: 17))
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .keyboardShortcut(",", modifiers: .command)
                .accessibilityLabel("Settings")
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.textMuted)
            .padding(.horizontal, 8)
            .background(Theme.sheet)
        }
        // NO SEPARATE LAYOUT READ ANY MORE. The arrangement rides each Mac's
        // live read (InboxStore), so refreshing the inbox refreshes where
        // things sit — and the rail learns about a drag made on the Mac on the
        // next poll instead of only when it is opened again.
        .refreshable { await inbox.refresh() }
        .task {
            collapsed = Set(savedCollapsed.split(separator: "\n").map(String.init))
        }
        .onChange(of: inbox.filter) { projectFilter = nil }
        .sheet(item: $snoozing) { row in snoozeSheet(row) }
        // RENAME IS AN ALERT, NOT A SHEET. One field and two buttons is the
        // alert's whole shape, and a sheet for it would cost a push and a
        // dismiss to type a title.
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
        // THE CONFIRMATION SAYS WHAT IT TAKES rather than asking "are you
        // sure": the engine deletes the transcript with the session and there
        // is no undo, so the sentence is the only place that can be said.
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

    /// `isPresented` for a modal whose subject is an optional row — the
    /// binding SwiftUI's `alert` and `confirmationDialog` take, derived from
    /// the one piece of state that actually says which row it is about.
    private func presenting<T>(_ subject: Binding<T?>) -> Binding<Bool> {
        Binding(get: { subject.wrappedValue != nil }, set: { if !$0 { subject.wrappedValue = nil } })
    }

    private var projectOptions: [SidebarProject] { SidebarModel(sessions: all.map { row in
        var session = row.session; session.activity = .idle; session.settledOverride = nil
        return HostedSession(hostId: row.hostId, session: session)
    }, names: inbox.projectName, remotes: { inbox.project($0)?.remoteUrl }, hostNames: { settings.host($0)?.name }).projects }

    private func hostName(_ id: HostID) -> String { settings.host(id)?.name ?? "Mac" }

    /// "HERE" IS A QUESTION ONCE A GROUP SPANS TWO MACS, so it stops being the
    /// answer and becomes a submenu — the desktop's own control
    /// (project-group.tsx). With one place the row is exactly what it was.
    ///
    /// EACH ENTRY IS BUILT FROM ITS PLACE, never from the group: project ids are
    /// minted per engine, so a draft carrying the laptop's id opens nothing on
    /// the mini.
    @ViewBuilder private func newConversation(_ group: SidebarProject) -> some View {
        if group.places.count > 1 {
            Menu("New conversation here", systemImage: "square.and.pencil") {
                ForEach(group.places) { place in
                    Button(hostName(place.hostId), systemImage: "desktopcomputer") { startDraft(place) }
                }
            }
        } else {
            Button("New conversation here", systemImage: "square.and.pencil") {
                startDraft(group.places.first ?? ProjectPlace(hostId: group.hostId, projectId: group.projectId, name: group.name, icon: group.icon))
            }
        }
    }

    private func startDraft(_ place: ProjectPlace) {
        resumeDraft(MobileDraft(hostId: place.hostId,
                                project: ProjectRef(id: place.projectId, name: place.name, icon: place.icon),
                                prompt: "", title: ""))
    }

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
            // THREE WEIGHTS, NOT TWO, AND THE THIRD IS THE ONE THAT MATTERS —
            // the desktop's rule (session-row.tsx), ported because the phone
            // had only the two. Card versus slim separates live from history;
            // inside the live band a session that is WORKING or WAITING ON YOU
            // is not the same as one that merely happens to be recent. A
            // hairline in the status colour on the leading edge reads down a
            // column of twenty rows without adding a pixel of height, and it
            // reuses the colour the status slot already established rather than
            // inventing a second language for the same fact.
            //
            // It rides OUTSIDE the content, in the cell's own leading inset, so
            // that it cannot push the row's text sideways: a bar that moved the
            // title would make a row jump every time its turn started.
            .overlay(alignment: .leading) {
                if variant == .card, let tone = accentTone(row.session) {
                    Capsule().fill(tone).frame(width: 2).padding(.vertical, 2).offset(x: -8)
                }
            }
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
            // THE MAC'S LIST, ITEM FOR ITEM (#326) — built in `SessionRowMenu`
            // rather than written out here, because the order and the labels
            // ARE the thing that has to match and a closure cannot be read by
            // a test. This renders them; it decides nothing.
            //
            // ONE LEVEL OF NESTING IS THE WHOLE SHAPE (Snooze, Copy), so the
            // two cases are written out rather than recursed: a recursive
            // `@ViewBuilder` has no base case a Swift generic can terminate on.
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

    /// The row's menu, resolved against one clock — two items reading their
    /// own `Date()` would resolve "In 1 hour" and the wake countdown against
    /// different instants in the same paint.
    ///
    /// SETTLED IS FOLDED HERE, not in the model: whether a session is off the
    /// list is a question about this reader's inbox policy, which the bands
    /// have already answered.
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
            // The detail COMPLEMENTS the label — "Tomorrow · 9:00 AM" — which
            // is the one place a menu row here carries two facts.
            Label(item.detail.map { "\(item.label) · \($0)" } ?? item.label, systemImage: item.systemImage)
        }
        .disabled(item.disabled != nil)
    }

    /// Every verb's side effect, in one place. `SessionRowMenu` says WHAT each
    /// row does and this says how, using the calls the sidebar already makes.
    private func run(_ verb: SessionMenuVerb?, on row: HostedSession) {
        switch verb {
        case .newSession(let projectId, let baseRef):
            let project = inbox.project(row)
                ?? ProjectRef(id: projectId, name: inbox.projectName(row) ?? "Project")
            resumeDraft(MobileDraft(hostId: row.hostId, project: project, prompt: "", title: "", baseRef: baseRef))
        case .pin(let pinned):
            Task { await patch(row, pinned ? SessionPatch(settledOverride: "active") : SessionPatch(clearSettledOverride: true)) }
        case .settle(let settled):
            Task { await inbox.setSettled(row.id, settled) }
        case .snooze(let until):
            // Waking clears the snooze AND pins the row back to the list, so a
            // session woken from the shelf does not settle again on the same
            // poll — the swipe action's rule, reused.
            Task { await patch(row, until.map { SessionPatch(snoozedUntil: $0) } ?? SessionPatch(settledOverride: "active", clearSnooze: true)) }
        case .rename:
            renameDraft = row.session.title
            renaming = row
        case .copy(let text):
            UIPasteboard.general.string = text
        case .delete:
            deleting = row
        case nil:
            break
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
                // The desktop dims a resting slim title to 70% and restores it
                // on hover; 85% was a hedge against having no hover to restore
                // it with, and what it actually cost was the DIFFERENCE — at
                // 85% a slim row and a card's title read as the same weight, so
                // the two volumes stopped being two.
                .font(Settling.showsUnreadMark(row.session) ? Theme.rowTitleSlim.weight(.medium) : Theme.rowTitleSlim)
                .foregroundStyle(Settling.showsUnreadMark(row.session) ? Theme.text : Theme.text.opacity(0.7))
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

    /// THE LEADING HAIRLINE'S COLOUR, or nothing when the row is at rest.
    ///
    /// The bands are the desktop's `activityBadge` (lib/session-activity.ts)
    /// exactly: a row wears the bar when it has a badge to wear, so an idle
    /// row — which shows an age rather than a status — has none. Blocked takes
    /// the attention tone and everything live takes the accent, which is the
    /// same pairing the status slot already uses two lines below.
    private func accentTone(_ session: Session) -> Color? {
        switch session.activity {
        case .blocked: return Theme.statusAmber
        case .working, .queued, .monitoring: return Theme.accent
        case .idle: return nil
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
    /// THE SELECTION GOES FIRST. A detail column still holding a session the
    /// engine no longer has would spend its next poll discovering that as a
    /// "not found" error, which is the wrong way to learn about a deletion you
    /// just asked for.
    private func remove(_ row: HostedSession) async {
        do {
            try await settings.api(for: row.hostId)?.deleteSession(row.session.id)
            if selection == row.id { selection = nil }
            await inbox.refresh()
        } catch {
            layoutError = (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
        }
    }
    /// WHICH GROUPS ARE SHUT, and the one place that writes it down. The
    /// header's own tap toggles a single id; the menu's two rows replace the
    /// whole set, so they share the persistence rather than each remembering
    /// to save.
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
    private func place(_ source: SidebarProject, before target: SidebarProject) async {
        guard source.id != target.id else { return }
        var drawn = model.projects
        guard let from = drawn.firstIndex(where: { $0.id == source.id }) else { return }
        let moved = drawn.remove(at: from)
        drawn.insert(moved, at: drawn.firstIndex(where: { $0.id == target.id }) ?? 0)
        await saveOrder(drawn)
    }
    /// THE WHOLE DRAWN LIST, WRITTEN ONCE PER MAC IT TOUCHES.
    ///
    /// A group that lives on two Macs is one row here and an entry in BOTH
    /// documents, so a drag that moves it has to say so on both — and each Mac
    /// is told only about the groups it actually holds, in the new relative
    /// order, keyed the way that Mac keys them (`SidebarProject.layoutKey`).
    ///
    /// A MAC WHOSE ORDER DID NOT CHANGE IS NOT WRITTEN. Dragging one group past
    /// another on the same Mac must not cost a round trip to every other Mac in
    /// the book.
    private func saveOrder(_ drawn: [SidebarProject]) async {
        var byHost: [HostID: [String]] = [:]
        for group in drawn {
            for place in group.places { byHost[place.hostId, default: []].append(group.layoutKey) }
        }
        for (host, order) in byHost where order != inbox.layout(host).projectOrder.filter(order.contains) {
            await saveOrder(order, host: host)
        }
    }
    /**
     RE-READ, THEN WRITE ONE FIELD.

     A phone that loaded before a reorder on the Mac used to overwrite that
     reorder on its next drop (#306): it sent the whole `projectOrder` it was
     holding — its own visible list, plus whatever it had cached for projects it
     could not see — from a copy that could be a minute old. So the arrangement
     is re-read immediately before the write, and only `projectOrder` is sent:
     the engine leaves an absent field alone, so a drop here cannot touch the
     row order (`sessionOrder`, `pinnedOrder`) a drag on the Mac just made.

     Last write wins on that ONE field, which is what the issue allows — the two
     devices are one person's, and the field they moved is the field they meant.

     Optimistic, like the desktop: the group lands where it was dropped on the
     same frame, and a Mac that refuses puts it back.
     */
    private func saveOrder(_ order: [String], host: HostID) async {
        guard let api = settings.api(for: host) else { return }
        let previous = inbox.layout(host)
        inbox.applyLayout(host, SidebarLayout(projectOrder: order, sessionOrder: previous.sessionOrder, pinnedOrder: previous.pinnedOrder))
        do {
            // A read that fails is not a reason to refuse the drop — the copy
            // in hand is still this phone's best word, and it is the one the
            // old code would have written anyway.
            let current = (try? await api.sidebarLayout()) ?? previous
            // Keys for projects this phone is not showing — another Mac's
            // groups, a project with nothing live — keep their slot rather than
            // being pruned by a drag that had nothing to do with them.
            let rest = current.projectOrder.filter { !order.contains($0) }
            inbox.applyLayout(host, try await api.setSidebarLayout(projectOrder: order + rest))
            layoutError = nil
        } catch {
            inbox.applyLayout(host, previous)
            layoutError = "Couldn't save project order. Try again when the Mac is connected."
        }
    }
}
