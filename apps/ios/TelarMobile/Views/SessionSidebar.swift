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
    /// The Mac a registration is being made on, and the sheet's subject.
    @State private var addingTo: AddProjectTarget?
    @State private var showUsage = false
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

    /// THE MARKS SCALE WITH THE LINE THEY LABEL (#718). `ProjectAvatar` and
    /// `ProviderIconView` are both proportional to the `size` they are handed
    /// — correct by construction, and #674 left them alone for that reason.
    /// What it did not look at was the CALL SITES, which hand them a literal.
    /// The row's text scales and the mark beside it does not, so the two drift
    /// apart at large text sizes; the mark ends up labelling a line it is no
    /// longer the size of.
    ///
    /// EACH ONE TAKES THE STYLE OF THE TEXT IT SITS NEXT TO, not one shared
    /// reference, which is the opposite of the choice `ScaledFrame` makes for
    /// tap targets — and deliberately. A tap target answers to the finger and
    /// wants one ratio across the app; a mark answers to the words beside it
    /// and has to track those or it stops matching its own line. That is why
    /// the two 11s below become different metrics: one sits against the title
    /// (`.subheadline`), the other against the branch (`.caption`), and they
    /// were only ever the same number by coincidence.
    @ScaledMetric(relativeTo: .footnote) private var groupMark: CGFloat = 16
    @ScaledMetric(relativeTo: .caption2) private var rowProjectMark: CGFloat = 12
    @ScaledMetric(relativeTo: .subheadline) private var titleProviderMark: CGFloat = 11
    @ScaledMetric(relativeTo: .caption) private var branchProviderMark: CGFloat = 11
    /// The slim row's one mark slot, which is a project avatar when there is a
    /// project and a provider mark when there is not. Both off the slim
    /// title's own style so the slot is the same size whichever fills it —
    /// they keep their different seeds because an avatar and a glyph do not
    /// read as the same weight at the same number.
    @ScaledMetric(relativeTo: .footnote) private var slimProjectMark: CGFloat = 13
    @ScaledMetric(relativeTo: .footnote) private var slimProviderMark: CGFloat = 12

    private var model: SidebarModel {
        SidebarModel(
            sessions: inbox.sections.active,
            names: inbox.projectName,
            marks: { inbox.project($0)?.mark ?? .none },
            remotes: { inbox.project($0)?.remoteUrl },
            hostNames: { settings.host($0)?.name },
            // Off the SAME project record every line above reads — the Mac
            // probed the disk and published the answer; the phone draws it.
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
                // EACH MAC'S BUILT-IN AGENT, above everything (#531) —
                // experimental, and absent on every phone whose Macs have never
                // switched one on.
                //
                // ONE ROW PER MAC, and nothing is looked up in that Mac's
                // sessions to draw it. The Main band this replaces had to find a
                // designated conversation among the rows, so it appeared a beat
                // late on a Mac still answering its first poll and not at all if
                // the conversation had fallen off the page. The Agent is not a
                // session: one flag decides, and the row is there the moment the
                // Mac says it is.
                //
                // FIRST, AND OUTSIDE SEARCH, for the desktop's reason: it is not
                // a band and not an entry in the list, it is the row that is
                // always in the same place. A search is a question about the
                // whole list and flattens every band — and this row is not in
                // the list to be found, so it simply goes.
                //
                // A DIRECT DESTINATION rather than a `NavigationLink(value:)`.
                // The value form resolves against the destinations registered
                // for session ids, and an Agent has no id in that namespace —
                // there is nothing to register it under.
                let agentRows = inbox.agents
                if !agentRows.isEmpty {
                    Section {
                        ForEach(agentRows) { row in
                            NavigationLink {
                                if let api = settings.api(for: row.hostId) {
                                    AgentView(hostId: row.hostId, api: api)
                                } else {
                                    // A Mac whose client cannot be built is one
                                    // this phone is no longer paired with. The
                                    // sentence is better than a blank screen.
                                    ContentUnavailableView(
                                        "That Mac is not connected",
                                        systemImage: "sparkles",
                                        description: Text("Pair with it again to reach its Agent.")
                                    )
                                }
                            } label: {
                                // A TALLER ROW WITH ONE STATUS LINE (#539). It
                                // was a single line the height of a conversation,
                                // on the argument that it only answers "where do
                                // I go to coordinate". The owner's first night
                                // says half of that was wrong: "is it working, is
                                // it waiting for me" is a question this row has,
                                // and answering nothing made the one
                                // always-present entry the least informative
                                // thing on the sidebar.
                                Label {
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(spacing: 6) {
                                            Text("Agent").font(.subheadline)
                                            // WHAT CAME IN WHILE THE SCREEN WAS
                                            // SHUT (#541 A). A wake no longer
                                            // starts a turn, so without this the
                                            // sidebar cannot say anything
                                            // arrived. A COUNT and never a tone:
                                            // whether any of it is waiting on a
                                            // person is the status line's job,
                                            // one line down, and two things
                                            // competing to signal urgency on one
                                            // row is how neither gets read.
                                            if let badge = row.badge {
                                                Text(badge)
                                                    .font(Theme.monoSmall)
                                                    .monospacedDigit()
                                                    .padding(.horizontal, 6)
                                                    .padding(.vertical, 1)
                                                    .background(Theme.surface, in: Capsule())
                                                    .foregroundStyle(Theme.textMuted)
                                                    .accessibilityLabel("\(badge) unread")
                                            }
                                            // WHICH MAC, and only when there is more
                                            // than one to tell apart — the rule
                                            // `HostLabel` applies to every other row
                                            // on this sidebar.
                                            if settings.hosts.count > 1, let name = settings.host(row.hostId)?.name {
                                                Text(name).font(.caption).foregroundStyle(Theme.textMuted)
                                            }
                                        }
                                        .lineLimit(1)
                                        agentStatusLine(row.status)
                                    }
                                } icon: {
                                    Image(systemName: "sparkles")
                                }
                                .padding(.vertical, 4)
                            }
                        }
                    } header: {
                        // A GLYPH BEFORE THE WORD, the treatment "Needs you"
                        // gets and for the same reason: it says this band is
                        // different before the word is read. No count — one Mac
                        // has at most one Agent, so a number here would only
                        // ever say how many Macs are paired.
                        HStack(spacing: 6) {
                            Image(systemName: "sparkles")
                            Text(agentRows.count > 1 ? "Agents" : "Agent")
                        }
                        .bandCaption()
                        .accessibilityElement(children: .combine)
                    }
                }
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
                let pinnedRows = model.pinned.filter(matches)
                if !pinnedRows.isEmpty {
                    Section {
                        ForEach(pinnedRows) { row in sessionRow(row) }
                            .onMove { offsets, destination in
                                Task { await reorder(pinnedRows, offsets: offsets, to: destination, key: .pinned) }
                            }
                    }
                }
                ForEach(model.projects) { group in
                    Section {
                        if !collapsed.contains(group.id) {
                            // SLIM: the header above already names the project,
                            // and a card's status and branch lines are mostly
                            // empty on an idle row — so the card was spending
                            // three lines to restate the header.
                            // ONE ROW PER CONVERSATION — issue #381. A session
                            // somebody delegated to used to draw indented under
                            // the one that delegated, which read as a sub-agent
                            // of it. It is a conversation; it draws like one.
                            let drawn = group.sessions
                            // THE HEADER'S BADGES ARE THE ROW'S CONTEXT. One
                            // place above and the header has already answered
                            // "which Mac"; two and it has only listed them.
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
                                // THE DRIVE IS AWAY — issue #534. The same muted
                                // chip the host badges below use, and never a
                                // warning colour: a project on an external drive
                                // is unreadable whenever the drive is elsewhere,
                                // which is the ordinary state of an external
                                // drive. Nothing here is broken and nothing needs
                                // fixing but a cable.
                                if let away = group.awayLabel {
                                    Text(away).font(Theme.metaSmall).foregroundStyle(Theme.textMuted)
                                        .lineLimit(1).padding(.horizontal, 4)
                                        .background(Theme.subtle, in: RoundedRectangle(cornerRadius: 3))
                                }
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
                            // MOVE UP AND MOVE DOWN ARE THE HEADER'S REORDER, and
                            // on this platform they are the whole of it (#348).
                            //
                            // The header carried a `.draggable` and it could never
                            // be lifted by touch: the long press is the menu's,
                            // and the drag never began. `.onMove` cannot replace
                            // it either — a header is a section, not a row in a
                            // `ForEach`, and the List reorders rows. So the drag
                            // is gone rather than left as an affordance that does
                            // nothing, and these two do the work on every input.
                            // They write the same document a drop would have
                            // (`saveOrder`), including for a group that lives on
                            // two Macs.
                            Button("Move up", systemImage: "arrow.up") { Task { await move(group, offset: -1) } }
                            Button("Move down", systemImage: "arrow.down") { Task { await move(group, offset: 1) } }
                        }
                    }
                }
                shelf("Snoozed", rows: inbox.sections.snoozed.sorted { ($0.session.snoozedUntil ?? 0) < ($1.session.snoozedUntil ?? 0) }, open: $snoozedOpen)
                // THE ROWS ARE NOT HERE UNTIL THIS IS OPENED (#457): the Macs
                // answer the unsettled list and say how many they kept, which
                // is what draws this and what the tap then asks for.
                shelf(
                    "Settled",
                    rows: inbox.sections.settled,
                    open: $settledOpen,
                    heldBack: inbox.shelvedOnMacs,
                    onOpen: { await inbox.showSettled() }
                )
            }
            // THE DESKTOP'S TWO SENTENCES, NOT ONE THAT COVERS BOTH — #357's
            // copy audit (`SidebarEmpty`, app-sidebar.tsx). "Your work starts
            // here / Start a conversation or pick up work from your Mac" was a
            // welcome, and it was the same welcome whether the Mac had fifty
            // projects and a quiet week or no registry at all — which are two
            // different situations with two different next steps. An empty
            // registry says so and names the verb that fixes it; an empty list
            // points at the button that fills it.
            if inbox.loaded && all.isEmpty {
                if inbox.hasProjects {
                    ContentUnavailableView("No sessions yet", systemImage: "text.bubble", description: Text("Start one from the button above."))
                } else {
                    ContentUnavailableView("No projects yet", systemImage: "folder.badge.plus", description: Text("Register a project to start a session."))
                }
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
        // THE HEADER'S VERBS, THE DESKTOP'S SET — issue #404. The rail there is
        // a search field with Add project and New conversation at its right
        // (app-sidebar.tsx), and the phone had only the compose button.
        //
        // ADD PROJECT IS A VERB, NOT A SETTING. Registering a folder used to be
        // reachable only from the new-conversation flow, which is the wrong way
        // round: you add a project in order to start conversations in it, so the
        // one that comes first cannot be behind the one that follows.
        //
        // THE PROJECT PICKER IS GONE, and the Mac filter stays. The desktop
        // dropped its "All projects ▾" row (#400) because the rail is already
        // grouped by project and the field already narrows it — a filter for the
        // same fact, spending a control. The Mac filter has no desktop
        // counterpart to drop: which machine a row is on is a fact only a phone
        // holding several Macs has to ask about.
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
        // A REGISTRATION IS A PUSH INSIDE A SHEET, not a push onto the rail: the
        // browser walks the MAC's folders and a person who gets lost in it wants
        // one dismissal, not a stack of them to unwind.
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
        // AN ICON ROW, NOT A SENTENCE. The desktop's footer
        // (app-sidebar-footer.tsx) is a row of muted glyphs on the left, and
        // that is the right shape for a destination you reach twice a week: a
        // full-width tinted "Settings" was the loudest thing on the rail,
        // reading as the sidebar's primary action directly beneath the work
        // that actually is.
        //
        // SETTINGS FIRST, THEN USAGE — the desktop's order and its reason
        // (app-sidebar-footer.tsx, #389): Settings is the one a person reaches
        // for, Usage is the one they look at. The phone drew only the gear
        // because there was no usage screen to open; there is one now (#404), so
        // the footer is the pair it is over there.
        //
        // The desktop's update control has no counterpart here — this app
        // updates through TestFlight, which is the App Store's job and not a
        // button's.
        //
        // The glyphs keep the web's size and the tap targets do not: 32pt is a
        // mouse target, and a finger is owed the full 44.
        //
        // BOTH GLYPHS BELOW SCALE WITH THEIR OWN SQUARE (#674). 17-in-44 is
        // the proportion at every text size, not just the default one — see
        // `scaledGlyphBox`.
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
        // NO SEPARATE LAYOUT READ ANY MORE. The arrangement rides each Mac's
        // live read (InboxStore), so refreshing the inbox refreshes where
        // things sit — and the rail learns about a drag made on the Mac on the
        // next poll instead of only when it is opened again.
        .refreshable { await inbox.refresh() }
        .task {
            collapsed = Set(savedCollapsed.split(separator: "\n").map(String.init))
        }
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

    private func hostName(_ id: HostID) -> String { HostLabel.name(settings.host(id)?.name) }

    /// WHICH MAC A FOLDER IS BEING REGISTERED ON. A project lives in one
    /// checkout on one machine, so "Add project" is only a plain button when
    /// there is one Mac it could mean — the same shape `newConversation` already
    /// uses for a group that spans two.
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
                startDraft(group.places.first ?? ProjectPlace(hostId: group.hostId, projectId: group.projectId, name: group.name, mark: group.mark))
            }
        }
    }

    private func startDraft(_ place: ProjectPlace) {
        resumeDraft(MobileDraft(hostId: place.hostId,
                                project: ProjectRef(id: place.projectId, name: place.name, icon: place.mark.icon,
                                                    iconName: place.mark.iconName, iconEmoji: place.mark.iconEmoji),
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
    ///
    /// `placesAbove` is how many Macs this row's group header names, and 0 when
    /// nothing is heading it. It is the row's whole input to `HostLabel.row`;
    /// see that type for why the header answering "which Mac" keeps the row
    /// quiet and the header LISTING two does not.
    private func sessionRow(
        _ row: HostedSession, variant: RowVariant = .card, showsProject: Bool = true, placesAbove: Int = 0
    ) -> some View {
        let host = HostLabel.row(
            name: settings.host(row.hostId)?.name, hostCount: settings.hosts.count, placesAbove: placesAbove
        )
        return NavigationLink(value: row.id) {
            Group {
                switch variant {
                case .card: cardBody(row, showsProject: showsProject, host: host)
                case .slim: slimBody(row, host: host)
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
        // WHY THE SHELF TOOK IT, ON EVERY VARIANT — the desktop carries this
        // sentence in the row's own `title`, which is variant-independent
        // (session-row.tsx), while the phone could only draw it in a slim row's
        // right-hand slot. That slot is contested: a delegate that is working
        // again takes it, and a card never had it at all, so the one settling
        // fact a reader cannot reconstruct was dropped exactly when the row had
        // something else to say. As a hint it is always there and costs no
        // pixels — which is what the desktop's tooltip is.
        .accessibilityHint(settledHint(row).map(Text.init) ?? Text(""))
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
                    .tint(Theme.textMuted)
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
        // NO `.draggable` HERE, AND THAT IS THE FIX (#348). A row carrying both a
        // `.draggable` and a `.contextMenu` cannot be reordered by touch: the
        // long press is claimed by the menu and the drag never begins, which is
        // exactly what the phone build reported. The List's own reorder is
        // attached to the band's `ForEach` instead (`.onMove`), and it does not
        // compete for the press — a press that MOVES lifts the row, a press that
        // is HELD opens this menu.
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
    @ViewBuilder private func cardBody(_ row: HostedSession, showsProject: Bool, host: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                if row.session.settledOverride == "active" {
                    Image(systemName: "pin.fill").font(.system(Theme.captionTiny)).foregroundStyle(Theme.textMuted.opacity(0.7))
                }
                // The attention and pinned bands, search and the shelves
                // mix projects, so the row names its own. A row under its
                // project's own header says nothing the header has not.
                if showsProject, let project = inbox.project(row) {
                    ProjectAvatar(name: project.name, projectId: project.id, hostId: row.hostId, mark: project.mark, api: settings.api(for: row.hostId), size: rowProjectMark)
                    Text(project.name).font(.caption2).foregroundStyle(Theme.textMuted.opacity(0.75)).lineLimit(1)
                }
                Spacer(minLength: 4)
                if let host { hostBadge(host) }
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
                    ProviderIconView(driver: row.session.driver, size: titleProviderMark).opacity(0.5)
                }
            }
            // NO THIRD LINE UNLESS IT SAYS SOMETHING THIS ROW ALONE WOULD
            // SAY. A branch differs per row; the model does not.
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
            // WHICH MAC, WHEN NOTHING ABOVE THE ROW HAS SAID — issue #244. It
            // rides ahead of the contested right-hand slot rather than in it:
            // the hint and the status are both claims about this conversation
            // and take turns, and which Mac it is on is neither, so it must not
            // be able to displace either of them.
            if let host { hostBadge(host) }
            // WHY THE SHELF TOOK IT, WHERE THE AGE WOULD BE — issue #378.
            //
            // A settled row's right-hand slot says "8h ago", which on this
            // shelf is the sort order restated. A row the ENGINE shelved has
            // something there that the reader cannot work out for themselves,
            // so it takes the slot; the age is one tap away in the row itself.
            //
            // ONLY WHEN THE SLOT HAS NOTHING LOUDER TO SAY. A delegate that is
            // working again, or asking something, is a claim about the present
            // and beats a claim about why it was shelved — which is the same
            // precedence `statusSlot` already reads top to bottom.
            if let hint = settledHint(row), row.session.activity == .idle, row.session.snoozedUntil == nil {
                Text(hint).font(.caption2).foregroundStyle(Theme.textMuted.opacity(0.7))
                    .lineLimit(1).truncationMode(.tail)
                    .layoutPriority(-1)
            } else {
                statusSlot(row.session)
            }
        }
    }

    /// The sentence, with the coordinator resolved on the row's OWN Mac — an
    /// assignment's ids are one engine's, so a global lookup could name a
    /// stranger. See `MergedInbox.title`.
    private func settledHint(_ row: HostedSession) -> String? {
        Settling.settledHint(
            row.session,
            coordinatorTitle: row.session.settledBy.flatMap { inbox.title($0.coordinatorSessionId, on: row.hostId) }
        )
    }

    /// THE MAC'S MARK, one drawing for both row variants — issue #244. The card
    /// already wore it and the slim row did not, so a conversation moved from
    /// the pinned band into its project group lost the only thing that said
    /// which machine it was on. One function so the two cannot drift.
    ///
    /// It carries no glyph, unlike the strip's: the rail draws these in company
    /// — beside a group header's list of them, above and below other rows
    /// wearing the same shape — and in company the shape is already the word.
    private func hostBadge(_ name: String) -> some View {
        Text(name).font(.system(Theme.caption)).foregroundStyle(Theme.textMuted.opacity(0.7))
            .lineLimit(1).truncationMode(.tail)
            .padding(.horizontal, 4).background(Theme.subtle, in: RoundedRectangle(cornerRadius: 3))
            .accessibilityLabel("On \(name)")
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

    /// THE AGENT ROW'S STATUS LINE (#539) — the same grammar `statusSlot` gives
    /// a session below, because a reader who has learned this list should not
    /// have to learn one row separately.
    ///
    /// A PULSING DOT FOR "STILL GOING", A STILL DOT FOR "WAITING FOR A PERSON",
    /// and nothing at all beside a quiet line: the motion is the fastest read on
    /// the sidebar, and an approval that has parked is exactly the thing that is
    /// NOT moving.
    @ViewBuilder private func agentStatusLine(_ status: AgentStatus) -> some View {
        HStack(spacing: 3) {
            switch status.tone {
            case .working: SteppedPulseDot(color: Theme.statusSky)
            case .waiting: Image(systemName: "circle.circle").font(.system(Theme.captionTiny))
            case .idle: EmptyView()
            }
            Text(status.label).lineLimit(1)
        }
        .font(.caption2.weight(status.tone == .idle ? .regular : .medium))
        .foregroundStyle(agentStatusTone(status.tone))
    }

    private func agentStatusTone(_ tone: AgentStatus.Tone) -> Color {
        switch tone {
        case .waiting: return Theme.statusAmber
        case .working: return Theme.statusSky
        case .idle: return Theme.textMuted.opacity(0.7)
        }
    }

    /// A SPINNER-DOT FOR "STILL GOING", A STILL DOT FOR "STOPPED AND WAITING",
    /// the wake time for a snoozed row, the relative time for everything else.
    @ViewBuilder private func statusSlot(_ session: Session) -> some View {
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

    /// `heldBack` IS THE COUNT OF ROWS THE MACS DID NOT SEND (#457), and it is
    /// what keeps this shelf drawable when it is empty.
    ///
    /// The live read answers only the unsettled rows until somebody opens the
    /// settled shelf, so `rows` is empty until then — and a shelf that hides
    /// itself when empty would be a shelf with no way to open it. `onOpen` is
    /// what asks for them, so the rows arrive on the tap rather than three
    /// seconds later on the next poll.
    @ViewBuilder private func shelf(
        _ name: String,
        rows: [HostedSession],
        open: Binding<Bool>,
        heldBack: Int = 0,
        // `@MainActor` and not `@Sendable`: it closes over the store, which is
        // main-actor-isolated, and the Task below inherits the same isolation.
        onOpen: (@MainActor () async -> Void)? = nil
    ) -> some View {
        let filtered = rows.filter(matches)
        // WHAT THE HEADER SAYS. Open, the rows are here and they are the
        // answer — filtered by the search field, which `heldBack` is not.
        // Closed, the Macs' own count is the only thing that knows there is
        // anything behind this at all.
        let count = open.wrappedValue ? filtered.count : max(filtered.count, heldBack)
        if !filtered.isEmpty || heldBack > 0 {
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
                Button {
                    let opening = !open.wrappedValue
                    open.wrappedValue = opening
                    // Only on the way OPEN, and only once it is: closing keeps
                    // whatever rows arrived, which cost nothing to hold.
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
    /// THE WHOLE DRAWN LIST, WRITTEN ONCE PER MAC IT TOUCHES.
    ///
    /// A group that lives on two Macs is one row here and an entry in BOTH
    /// documents, so a move has to say so on both — and each Mac is told only
    /// about the groups it actually holds, in the new relative order, keyed the
    /// way that Mac keys them (`SidebarProject.layoutKey`).
    ///
    /// A MAC WHOSE ORDER DID NOT CHANGE IS NOT WRITTEN. Moving one group past
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
    /// A CONVERSATION LIFTED AND PUT DOWN SOMEWHERE ELSE IN ITS BAND — the List's
    /// own reorder, handed the band exactly as it was drawn when the finger went
    /// down.
    ///
    /// A GESTURE THAT RESOLVED TO WHERE THE ROW ALREADY WAS COSTS NOTHING:
    /// `reordered` answers nil, and no write is made.
    private func reorder(_ drawn: [HostedSession], offsets: IndexSet, to destination: Int, key: RowOrderKey) async {
        guard let move = SidebarModel.reordered(drawn, offsets: offsets, to: destination) else { return }
        await saveRowOrder(move.ids, key: key, host: move.host)
    }

    /// Which list a row's move writes. Two cases rather than an optional key, so
    /// a group lookup that came back empty can never quietly write the pinned band.
    private enum RowOrderKey {
        case pinned
        case group(String)
    }

    /**
     THE SAME DISCIPLINE `saveOrder` DOCUMENTS, one level down: re-read, then
     write ONE field.

     `sessionOrder` is a map, so writing it means sending the whole map — and a
     map this phone was holding from a minute ago would resurrect the group order
     a drag on the Mac replaced in between. So the document is re-read
     immediately before the write and this group's key is MERGED INTO IT, which
     is the desktop's own rule (`setSessionOrder`, lib/sidebar-layout.ts): a drop
     on the phone leaves every other group's rows exactly as the Mac has them.

     `pinnedOrder` and `projectOrder` are never named, so the engine leaves them
     alone — the field you dragged is the field that moves.
     */
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
            // A read that fails is not a reason to refuse the drop — the copy in
            // hand is still this phone's best word.
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
