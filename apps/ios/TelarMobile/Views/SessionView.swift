import SwiftUI
import PhotosUI

struct SessionView: View {
    @State private var store: SessionStore
    @State private var draft = ""
    @State private var renaming = false
    @State private var renameDraft = ""
    /// The right panel: which tab, which files, whether it is showing.
    @State private var panel: PanelModel
    /// PRESENTATION IS STATE, NOT A COMPUTED BINDING. `.inspector` keeps its
    /// `isPresented` binding and compares it to decide whether the split view
    /// needs another update; a `Binding(get:set:)` built in `body` is a NEW
    /// location on every pass, so the comparison always said "changed". The
    /// inspector re-updated, that dirtied layout, layout re-ran `body`, and
    /// the app's first CoreAnimation commit never converged — a hang before
    /// anything was ever tapped, with no runaway of our own to find. A
    /// `@State` projection is one location for the life of the view.
    @State private var inspectorShown = false
    @State private var pushShown = false
    /// Which sidebar state the panel found so it can put it back on close.
    @State private var sidebarWasVisible = false
    /// `display.opened` events seen this mount — the journal replays from
    /// zero on every load, and without the guard every reload re-opens last
    /// week's file.
    @State private var seenDisplays: Set<Int> = []
    @State private var mountedAt = Timestamp(Date().timeIntervalSince1970 * 1000)
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.columnVisibility) private var columnVisibility
    /// Stick-to-bottom (t3's `use-stick-to-bottom`), the native iOS 18 way: a
    /// position pinned to an EDGE rather than an offset stays on that edge as
    /// the content grows, which is the whole behaviour. `isPositionedByUser`
    /// flips the moment the reader scrolls, and that is what "let them go"
    /// keys on. `.defaultScrollAnchor` cannot do this job — it is solved once,
    /// when the ScrollView first appears, and the transcript is still EMPTY
    /// then (the snapshot lands a poll later), so it anchors nothing.
    @State private var position = ScrollPosition(edge: .bottom)
    /// Geometry's answer to "parked at the tail?" — only meaningful once the
    /// reader has taken control; before that the pin is the truth.
    @State private var isAtBottom = true
    private let api: any EngineAPI
    private let sessionId: EngineID
    private let hostId: HostID?
    private let cockpitBaseURL: URL?
    @State private var previousVisit: Int?
    @State private var dismissedRecap = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss

    init(api: any EngineAPI, sessionId: EngineID, hostId: HostID? = nil, cockpitBaseURL: URL? = nil, cache: HostSnapshotCache? = nil) {
        self.api = api
        self.sessionId = sessionId
        self.hostId = hostId
        self.cockpitBaseURL = cockpitBaseURL
        if let hostId {
            let value = UserDefaults.standard.integer(forKey: "telar.lastVisit.\(hostId).\(sessionId)")
            _previousVisit = State(initialValue: value > 0 ? value : nil)
        }
        if let hostId { _draft = State(initialValue: UserDefaults.standard.string(forKey: "telar.draft.\(hostId).\(sessionId)") ?? "") }
        // NOT STARTED HERE. SwiftUI runs this initialiser on every parent
        // re-render and keeps only the first store; a loop started from it
        // would outlive the store that was thrown away. `.task` starts it.
        _store = State(initialValue: SessionStore(api: api, sessionId: sessionId, hostId: hostId, cache: cache))
        _panel = State(initialValue: PanelModel(hostId: hostId, sessionId: sessionId))
    }

    /// The same API, as the panel sees it — only the HTTP client conforms;
    /// a test double is not a panel.
    private var panelAPI: (any PanelAPI)? { api as? any PanelAPI }

    /// The refresh signal every panel surface keys on: a turn settling.
    private var turnActive: Bool { store.hasActiveTurn }

    /// On a regular width the panel is a column beside the transcript; on a
    /// compact one it is a full-screen push. One of the two flags is raised,
    /// never both.
    private var wantsColumn: Bool { sizeClass == .regular }

    /// THE MODEL IS THE TRUTH: raise whichever presentation this width uses to
    /// match it. Every write is guarded — a presentation modifier writes its
    /// own binding back on layout, sometimes with the value it already holds.
    private func raisePanel(_ open: Bool) {
        let column = open && wantsColumn
        let push = open && !wantsColumn
        if inspectorShown != column { inspectorShown = column }
        if pushShown != push { pushShown = push }
    }

    /// The other direction: the reader closed the column or popped the push.
    private func panelPresented(_ open: Bool) {
        guard open != panel.isOpen else { return }
        if open { panel.open() } else { panel.close() }
    }

    /// There is room for sidebar, transcript and panel only in landscape, so
    /// opening the panel hides the sidebar when the window is narrower than
    /// all three need, and closing it puts the sidebar back if it was there.
    private func syncSidebar(open: Bool) {
        guard sizeClass == .regular, let visibility = columnVisibility else { return }
        let width = UIScreen.main.bounds.width
        let roomForThree = width >= 300 + Theme.readingMeasure + 440
        if open, !roomForThree, visibility.wrappedValue != .detailOnly {
            sidebarWasVisible = true
            withAnimation { visibility.wrappedValue = .detailOnly }
        } else if !open, sidebarWasVisible {
            sidebarWasVisible = false
            withAnimation { visibility.wrappedValue = .all }
        }
    }

    /// Queued and steering messages live in the strip under the composer; a
    /// STEERED one's content already appears inside the host turn as a
    /// user_message item — rendering the turn too is the double bubble.
    /// (Web rule, 1:1.)
    private var visibleTurns: [JournalTurn] {
        store.sync.turns.filter {
            $0.state != .queued && $0.state != .steering && $0.state != .steered
        }
    }

    /// What can change the transcript's HEIGHT, and nothing else. Keying the
    /// follow on `lastActivityAt` was the scroll loop: it moves on every
    /// `content.delta` (~once per poll), so each tick started a fresh animated
    /// scroll against a target the LazyVStack was still re-measuring.
    private var contentFingerprint: String {
        let turns = visibleTurns
        guard let last = turns.last else { return "empty" }
        let lastItem = last.items.last
        return [
            String(turns.count),
            String(last.items.count),
            String(last.tasks.count),
            lastItem?.id ?? "-",
            String(lastItem?.streamedText.count ?? 0),
            last.state.rawValue,
        ].joined(separator: "/")
    }

    /// The button is for a reader who walked away, so it needs BOTH: they took
    /// control, and they are not at the tail. Geometry alone showed it on open,
    /// while the first fill was still settling and nobody had scrolled.
    private var showsJumpButton: Bool {
        position.isPositionedByUser && !isAtBottom
    }

    var body: some View {
        VStack(spacing: 0) {
            if let session = store.sync.session {
                HStack(spacing: 6) {
                    ActivityBadge(activity: session.activity)
                    Text(session.activity == .blocked ? "Needs you" : session.activity.rawValue.capitalized)
                    Spacer()
                    Text(session.workspace.branch ?? session.driver).lineLimit(1)
                }
                .font(.caption).foregroundStyle(Theme.textMuted).padding(.horizontal, 16).padding(.vertical, 8)
                .readingColumn(gutter: Theme.readingGutter)
            }
            if let previousVisit, !dismissedRecap,
               let ended = store.sync.session?.lastTurnEndedAt, ended > previousVisit {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "sparkle").foregroundStyle(Theme.accent)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Since your last visit").font(.subheadline.weight(.semibold))
                        Text(store.sync.session?.lastTurnFailed == true ? "The last turn failed. Review its result below." : "A turn finished while you were away.").font(.caption)
                        if let result = visibleTurns.last(where: { !$0.resultText.isEmpty })?.resultText {
                            Text(result).font(.caption).lineLimit(3).foregroundStyle(Theme.textMuted)
                        }
                    }
                    Spacer(minLength: 0)
                    Button("Dismiss", systemImage: "xmark") { dismissedRecap = true }.labelStyle(.iconOnly)
                }
                .padding()
                .background(Theme.messageSurface)
                // A CARD, INSET, LIKE EVERY OTHER FILLED ROW HERE. The banner
                // had no container at all, so its fill ran the full width of
                // the detail while the transcript and the composer were both
                // inset — on an iPad in landscape with the panel open it
                // reached from the detail's leading edge, under the floating
                // sidebar, all the way to the panel. The radius is the one
                // `StatusCard` uses above the composer.
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("Recap banner")
                .padding(.horizontal, 16)
                .readingColumn(gutter: Theme.readingGutter)
            }
            ScrollView {
                VStack(spacing: 0) {
                    // AN EXPLICIT TAP, NOT A SCROLL TRIGGER — the reader
                    // asking for history is the only thing that fetches it.
                    // Prepending does not re-pin the tail: `contentFingerprint`
                    // reads only the LAST turn (plus the count, which changes,
                    // but `followTail` defers to `isPositionedByUser`, and a
                    // reader at this button has scrolled).
                    if store.sync.hasOlderTurns {
                        loadEarlierButton
                    }
                    // Queued messages live below the composer (t3's queue
                    // line), not in the transcript.
                    // THE READING MEASURE. The web caps the message lane at
                    // 50rem; at the phone's larger body size the same feel is
                    // narrower, and on an iPad the column would otherwise
                    // run the full width of the detail pane.
                    TranscriptView(turns: visibleTurns)
                        .readingColumn()
                        .padding(.vertical, 12)
                }
            }
            .scrollPosition($position)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height
                    >= geometry.contentSize.height - 40
            } action: { _, atBottom in
                isAtBottom = atBottom
            }
            // THE CASE THAT WAS BROKEN: the transcript arrives a poll after the
            // view does, so the first non-empty fill is the real "open", and
            // that is when the tail has to be re-pinned.
            .onChange(of: visibleTurns.isEmpty) { _, isEmpty in
                guard !isEmpty else { return }
                followTail()
            }
            .onChange(of: contentFingerprint) { followTail() }
            .overlay(alignment: .bottomTrailing) {
                jumpToBottomButton()
                    .opacity(showsJumpButton ? 1 : 0)
                    .allowsHitTesting(showsJumpButton)
                    .animation(.easeInOut(duration: 0.15), value: showsJumpButton)
            }
            footer
        }
        .background(Theme.canvas)
        .task { store.sync.start() }
        .onAppear {
            if let hostId { MobileNotifications.shared.visibleSession = .init(hostId: hostId, sessionId: sessionId) }
        }
        .onChange(of: draft) { _, text in
            if let hostId { UserDefaults.standard.set(text, forKey: "telar.draft.\(hostId).\(sessionId)") }
        }
        .onChange(of: store.sync.session) { _, session in
            if let session, let hostId { Task { await MobileNotifications.shared.update(session, hostId: hostId) } }
        }
        .alert("Live Activity", isPresented: Binding(get: { MobileNotifications.shared.activityError != nil }, set: { if !$0 { MobileNotifications.shared.activityError = nil } })) {
            Button("OK") { MobileNotifications.shared.activityError = nil }
        } message: { Text(MobileNotifications.shared.activityError ?? "") }

        .onDisappear {
            store.sync.stop()
            if MobileNotifications.shared.visibleSession?.sessionId == sessionId && MobileNotifications.shared.visibleSession?.hostId == hostId {
                MobileNotifications.shared.visibleSession = nil
            }
            recordVisit()
        }
        .userActivity("com.telar.session", isActive: cockpitBaseURL != nil && store.sync.session != nil) { activity in
            guard let base = cockpitBaseURL, let session = store.sync.session else { return }
            activity.title = session.title
            activity.webpageURL = session.cockpitURL(base: base)
            activity.isEligibleForHandoff = true
        }
        .onChange(of: scenePhase) { _, phase in
            // Poll only while someone is looking.
            if phase == .active {
                store.sync.start()
                if let hostId { MobileNotifications.shared.visibleSession = .init(hostId: hostId, sessionId: sessionId) }
            } else { store.sync.stop(); recordVisit(); MobileNotifications.shared.visibleSession = nil }
        }
        .onChange(of: store.sync.connection) { _, connection in
            if connection == .gone { dismiss() }
        }
        .environment(\.panel, panel)
        .inspector(isPresented: $inspectorShown) {
            NavigationStack {
                PanelView(api: api, panelAPI: panelAPI, sessionId: sessionId, hostId: hostId, active: turnActive, panel: panel, onClose: { panel.close() })
                    .toolbar(.hidden, for: .navigationBar)
            }
            .inspectorColumnWidth(min: 360, ideal: 440, max: 640)
        }
        .navigationDestination(isPresented: $pushShown) {
            PanelView(api: api, panelAPI: panelAPI, sessionId: sessionId, hostId: hostId, active: turnActive, panel: panel, onClose: { panel.close() })
                .navigationTitle("Panel")
                .navigationBarTitleDisplayMode(.inline)
        }
        .onChange(of: panel.isOpen, initial: true) { _, open in
            raisePanel(open)
            syncSidebar(open: open)
        }
        .onChange(of: inspectorShown) { _, open in if wantsColumn { panelPresented(open) } }
        .onChange(of: pushShown) { _, open in if !wantsColumn { panelPresented(open) } }
        // A rotation or a multitasking resize moves the panel between the
        // column and the push; the model says whether it is showing at all.
        .onChange(of: wantsColumn) { raisePanel(panel.isOpen) }
        .task(id: "\(sessionId):plugins") { await readPlugins() }
        .onChange(of: panel.generation) {
            // A file opened from a chip or a `display.opened` event: make
            // sure the panel is showing and the sidebar has made room.
            if panel.isOpen { syncSidebar(open: true) }
        }
        .onChange(of: store.sync.displayOpens.count) { watchDisplayOpens() }
        .navigationTitle(store.sync.session?.title ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .alert("Rename session", isPresented: $renaming) {
            TextField("Title", text: $renameDraft)
            Button("Rename") { Task { await store.rename(renameDraft) } }
            Button("Cancel", role: .cancel) {}
        }
    }

    /// Which tabs this session gets: the project's two opt-ins, read once
    /// the way the web reads them. Off until known.
    private func readPlugins() async {
        guard let panelAPI else { return }
        var projectId = store.sync.session?.projectId
        if projectId == nil {
            projectId = (try? await api.session(sessionId, window: SnapshotWindow(turns: 1)))?.session.projectId
        }
        guard let projectId, let projects = try? await panelAPI.projects(), let project = projects.first(where: { $0.id == projectId }) else { return }
        panel.setPlugins(dataScience: project.dataScience?.enabled == true, latex: project.latex?.enabled == true)
    }

    /// The agent asked the cockpit to show a file. Only events newer than
    /// this mount count, and each only once.
    private func watchDisplayOpens() {
        let fresh = store.sync.displayOpens.filter { $0.at >= mountedAt && !seenDisplays.contains($0.id) }
        guard !fresh.isEmpty else { return }
        for open in fresh { seenDisplays.insert(open.id) }
        if let last = fresh.last { panel.openFile(last.path) }
    }

    private func recordVisit() {
        guard let hostId, store.sync.recordedAt == nil, store.sync.session != nil else { return }
        UserDefaults.standard.set(Int(Date().timeIntervalSince1970 * 1000), forKey: "telar.lastVisit.\(hostId).\(sessionId)")
    }

    /// Re-pin to the tail, unless the reader has taken the scroll — scrolled
    /// away means scrolled away, and nothing here yanks them back.
    /// No animation: following should read as content growing under a fixed
    /// viewport, and an animation per delta is what made it visibly pump.
    private func followTail() {
        guard !position.isPositionedByUser else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            position.scrollTo(edge: .bottom)
        }
    }

    /// "Load earlier turns" — a quiet pill at the transcript's top, in the
    /// toolbar-pill vocabulary (subtle fill, hairline, capsule).
    private var loadEarlierButton: some View {
        Button {
            Task { await store.sync.loadOlderTurns() }
        } label: {
            Text(store.sync.loadingOlder ? "Loading earlier turns…" : "Load earlier turns")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.textMuted)
                .padding(.horizontal, 14)
                .frame(height: 32)
                .background(Theme.subtle)
                .clipShape(Capsule())
                .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(store.sync.loadingOlder)
        .padding(.top, 12)
    }

    /// The way back to the tail once you've read up. This one DOES animate —
    /// a deliberate tap, not a follow.
    private func jumpToBottomButton() -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.2)) {
                position.scrollTo(edge: .bottom)
            }
        } label: {
            Image(systemName: "arrow.down")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.text)
                .frame(width: 36, height: 36)
                .background(Theme.card)
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
                .shadow(color: .black.opacity(0.15), radius: 8, y: 3)
        }
        .buttonStyle(.plain)
        .padding(.trailing, 16)
        .padding(.bottom, 12)
        .accessibilityLabel("Scroll to the newest message")
    }

    /// t3's sticky overlay: pending cards above, then the composer on a
    /// bottom gradient scrim.
    @ViewBuilder private var footer: some View {
        VStack(spacing: 12) {
            if case .retrying(let message) = store.sync.connection {
                StatusCard(tint: Theme.statusAmber) {
                    HStack(spacing: 6) {
                        Image(systemName: "wifi.exclamationmark").font(.system(size: 11))
                        // WHAT IS ON SCREEN, when it is the phone's own copy:
                        // the transcript stays, and the card says how old it
                        // is instead of pretending it is the Mac's answer.
                        Text(store.sync.recordedAt.map { "Showing what was recorded at \(recordedAtLabel($0)) — reconnecting…" } ?? message)
                            .font(.system(size: 13)).lineLimit(2)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Theme.statusAmber)
                }
            }
            ForEach(store.sync.openRequests) { request in
                StatusCard(tint: Theme.statusAmber) {
                    RequestCardView(request: request, store: store)
                }
            }
            if let error = store.sendError, store.pendingSend != nil {
                StatusCard(tint: Theme.statusRed) {
                    HStack(spacing: 8) {
                        Text("Not sent — \(error)")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.statusRed)
                            .lineLimit(2)
                        Spacer(minLength: 0)
                        Button("Retry") { Task { await store.retryPending() } }
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Theme.text)
                            .buttonStyle(.plain)
                        Button("Discard") { store.discardPending() }
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Theme.statusRed)
                            .buttonStyle(.plain)
                    }
                }
            }
            ComposerView(draft: $draft, store: store)
        }
        .padding(.horizontal, 16)
        .readingColumn(gutter: Theme.readingGutter)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(alignment: .bottom) { ComposerScrim() }
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if let hostId, let session = store.sync.session {
                    let ref = ScopedSessionID(hostId: hostId, sessionId: sessionId)
                    Button(MobileNotifications.shared.isMuted(ref) ? "Unmute notifications" : "Mute notifications", systemImage: "bell.slash") {
                        Task { await MobileNotifications.shared.toggleMute(ref) }
                    }
                    if let base = cockpitBaseURL {
                        ShareLink(item: session.cockpitURL(base: base)) { Label("Continue on your Mac", systemImage: "desktopcomputer") }
                    }
                }
                Button("Panel", systemImage: "sidebar.trailing") {
                    panel.open()
                }
                Button("Changes", systemImage: "plus.forwardslash.minus") {
                    panel.open(.diff)
                }
                Button("Rename", systemImage: "pencil") {
                    renameDraft = store.sync.session?.title ?? ""
                    renaming = true
                }
                if store.sync.session?.settledOverride == "settled" {
                    Button("Un-settle", systemImage: "arrow.uturn.backward") {
                        Task { await store.setSettled(false) }
                    }
                } else {
                    Button("Settle", systemImage: "checkmark") {
                        Task { await store.setSettled(true) }
                    }
                }
                if let usage = store.sync.session?.usage {
                    Section {
                        Text(usageLine(usage))
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .foregroundStyle(Theme.textMuted)
            }
            .accessibilityLabel("Session actions")
        }
    }

    private func usageLine(_ usage: UsageSnapshot) -> String {
        let total = usage.tokens.input + usage.tokens.output + usage.tokens.cacheRead + usage.tokens.cacheCreate
        let tokens = total >= 1_000_000
            ? String(format: "%.1fM tokens", Double(total) / 1_000_000)
            : "\(total / 1000)k tokens"
        if let cost = usage.costUsd {
            return tokens + String(format: " · $%.2f", cost)
        }
        return tokens
    }
}

/// t3's bottom wash: the composer floats on a vertical gradient toward the
/// canvas, not on a solid bar.
struct ComposerScrim: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let base: Color = scheme == .dark ? .black : .white
        LinearGradient(
            stops: [
                .init(color: base.opacity(0), location: 0),
                .init(color: base.opacity(0.6), location: 0.55),
                .init(color: base.opacity(0.9), location: 1),
            ],
            startPoint: .top, endPoint: .bottom
        )
        .ignoresSafeArea(edges: .bottom)
        .allowsHitTesting(false)
    }
}

/// A pending card above the composer — rounded 16, card fill washed with the
/// status tint, hairline. (t3 renders approvals as standalone cards in the
/// sticky overlay, not fused drawers.)
struct StatusCard<Content: View>: View {
    let tint: Color
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.opacity(0.06))
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Theme.border, lineWidth: 1)
            )
    }
}

/// t3 mobile's composer, ported: a capsule pill at rest that morphs into a
/// radius-20 card on focus (220ms linear, focus is the ONLY driver), with the
/// toolbar row appearing under the card and the queue line under that.
struct ComposerView: View {
    @Binding var draft: String
    let store: SessionStore

    @FocusState private var focused: Bool
    @State private var managingQueue = false
    @State private var pickedPhotos: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    @State private var showingStash = false
    @State private var stashNote: String?
    @Environment(\.colorScheme) private var scheme

    private var isRunning: Bool { store.hasRunningTurn }
    private var queued: [JournalTurn] { store.queuedTurns }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !store.pendingAttachments.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            if let stashNote {
                Text(stashNote)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 6)
            }
            surface
            if focused { toolbar }
            if !queued.isEmpty { queueLine }
        }
        .animation(.linear(duration: 0.22), value: focused)
        .animation(.linear(duration: 0.18), value: queued.count)
        .sheet(isPresented: $showingStash) {
            StashSheet { entry in restore(entry) }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $pickedPhotos, maxSelectionCount: 8, matching: .images)
        .onChange(of: pickedPhotos) { _, items in
            guard !items.isEmpty else { return }
            pickedPhotos = []
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        await store.attach(
                            data: data,
                            name: (item.itemIdentifier ?? "photo") + ".jpg",
                            mediaType: item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"
                        )
                    }
                }
            }
        }
    }

    // MARK: the surface

    private var surface: some View {
        VStack(alignment: .leading, spacing: 0) {
            if focused && !store.pendingAttachments.isEmpty {
                attachmentStrip.padding(.bottom, 10)
            }
            // AT REST THE ROW IS CENTRED: the field sits on the pill's centre
            // line beside the 44pt send button. Bottom alignment is for the
            // focused card, where a growing field keeps the send button on
            // its last line. Bottom-aligning a 36pt field against a 44pt
            // button at rest was the placeholder sitting low in the pill.
            HStack(alignment: focused ? .bottom : .center, spacing: 8) {
                TextField("Ask the agent, or run a command…", text: $draft, axis: .vertical)
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.text)
                    .lineLimit(focused ? 7 : 1)
                    .frame(minHeight: focused ? 80 : 44, alignment: focused ? .topLeading : .leading)
                    .padding(.vertical, focused ? 8 : 0)
                    .focused($focused)
                    .onSubmit { submit() }
                if !focused {
                    if !store.pendingAttachments.isEmpty {
                        Text("+\(store.pendingAttachments.count)")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(Theme.textMuted2)
                            .frame(width: 30, height: 30)
                            .background(Theme.subtleStrong)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    ControlPillButton(
                        isRunning: isRunning, canSend: canSend,
                        action: { isRunning ? stop() : submit() }
                    )
                }
            }
        }
        .padding(.leading, focused ? 14 : 18)
        .padding(.trailing, focused ? 14 : 5)
        .padding(.vertical, focused ? 12 : 5)
        .composerGlass(cornerRadius: focused ? 20 : 27)
        .shadow(color: .black.opacity(scheme == .dark ? 0.35 : 0.12), radius: 14, y: 6)
        .onTapGesture { focused = true }
    }

    /// 72×72 radius-16 thumbs with a 22pt dark remove circle — the expanded
    /// card's strip. Files aren't previewable images here; the name carries.
    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(store.pendingAttachments) { attachment in
                    ZStack(alignment: .topTrailing) {
                        VStack(spacing: 6) {
                            Image(systemName: attachment.mediaType.hasPrefix("image/") ? "photo" : "doc")
                                .font(.system(size: 20))
                                .foregroundStyle(Theme.textMuted2)
                            Text(attachment.name)
                                .font(.system(size: 10))
                                .foregroundStyle(Theme.textMuted2)
                                .lineLimit(1)
                        }
                        .frame(width: 72, height: 72)
                        .background(Theme.subtle)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        Button {
                            store.removeAttachment(attachment.id)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 22, height: 22)
                                .background(Color.black.opacity(0.55))
                                .clipShape(Circle())
                        }
                        .padding(4)
                        .accessibilityLabel("Remove \(attachment.name)")
                    }
                }
                if store.uploading {
                    ProgressView()
                        .frame(width: 72, height: 72)
                        .background(Theme.subtle)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
        }
    }

    // MARK: the toolbar (expanded only)

    private var toolbar: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    // A BUTTON, NOT AN INLINE PhotosPicker. The picker used to
                    // live here, inside a toolbar that only exists while the
                    // field is focused. Presenting it dropped focus → the
                    // toolbar (and the picker with it) unmounted → the sheet
                    // closed and re-opened on remount, every time, so a photo
                    // could never be sent. The sheet is now presented from the
                    // composer's root (see `.photosPicker` on `body`), which
                    // outlives focus.
                    Button {
                        pickingPhotos = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 16))
                            .foregroundStyle(Theme.text)
                            .frame(width: 44, height: 44)
                            .background(Theme.subtle)
                            .clipShape(Circle())
                            .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
                    }
                    .accessibilityLabel("Attach photos")
                    // THE STASH sits beside the attach button because that
                    // cluster is already "things that go into this message".
                    StashButton(hasDraft: !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                                onStash: stashDraft, onOpen: { showingStash = true })
                    if isRunning {
                        ToolbarPill(variant: .danger) {
                            stop()
                        } label: {
                            Image(systemName: "stop.fill").font(.system(size: 14))
                        }
                        .accessibilityLabel("Stop the running turn")
                    }
                    modelPill
                    labeledPill(icon: "slider.horizontal.3",
                                label: ComposerView.runtimeModes.first { $0.0 == runtimeMode }?.1 ?? "Configuration") {
                        ForEach(ComposerView.runtimeModes, id: \.0) { mode, label in
                            Button {
                                Task { await store.setRuntimeMode(mode) }
                            } label: {
                                menuRow(label, selected: mode == runtimeMode)
                            }
                        }
                    }
                }
            }
            Button {
                submit()
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(canSend ? Theme.primaryGlyph : Theme.textMuted2)
                    .frame(width: 44, height: 44)
                    .background(canSend ? Theme.primaryFill : Theme.subtleStrong)
                    .clipShape(Circle())
            }
            .disabled(!canSend)
            .accessibilityLabel(isRunning || !queued.isEmpty ? "Queue" : "Send")
        }
        .padding(.top, 8)
        .padding(.bottom, 2)
    }

    private var runtimeMode: String {
        store.sync.session?.runtimeMode ?? "approval-required"
    }

    /// The fused provider+model pill — driver fixed (a session belongs to
    /// its provider), everything else changeable per turn.
    private var modelPill: some View {
        let driver = store.sync.session?.driver ?? "claude"
        let selection = store.sync.session?.model
        return ModelPillView(
            catalogues: store.catalogue.map { [driver: $0] } ?? [:],
            choice: ModelChoice(
                driver: driver, model: selection?.model,
                effort: selection?.effort, fastMode: selection?.fastMode
            ),
            driversSwitchable: false,
            onChange: { next in Task { await store.setModelChoice(next) } }
        )
        .task { await store.loadModels() }
    }

    @ViewBuilder private func menuRow(_ label: String, selected: Bool) -> some View {
        if selected {
            Label(label, systemImage: "checkmark")
        } else {
            Text(label)
        }
    }

    private func labeledPill<Items: View>(icon: String, label: String, @ViewBuilder items: () -> Items) -> some View {
        Menu {
            items()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon).font(.system(size: 14))
                Text(label)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .medium))
            }
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 14)
            .frame(height: 44)
            .frame(maxWidth: 172)
            .background(Theme.subtle)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
        }
    }

    // MARK: the queue

    private var queueLine: some View {
        let steering = queued.filter { $0.state == .steering }
        let waiting = queued.filter { $0.state == .queued }
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                managingQueue.toggle()
            } label: {
                HStack(spacing: 6) {
                    if !steering.isEmpty { SteppedPulseDot(color: Theme.statusSky) }
                    // Steering is NOT silent: the injection waits for a safe
                    // boundary in the provider stream, which can take a
                    // while — a vanished message reads as a dropped one.
                    Text(steering.isEmpty
                         ? "\(waiting.count) queued message\(waiting.count == 1 ? "" : "s") will send automatically."
                         : "Sending into the running turn…")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textMuted2)
                }
            }
            .buttonStyle(.plain)
            if managingQueue {
                ForEach(queued) { turn in
                    let sending = turn.state == .steering
                    HStack(spacing: 10) {
                        Text(turn.prompt)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.text)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if sending {
                            Text("sending")
                                .font(.system(size: 10, weight: .medium))
                                .textCase(.uppercase)
                                .foregroundStyle(Theme.statusSky)
                        } else {
                            if isRunning && store.sync.session?.driver != "opencode" {
                                Button {
                                    Task { await store.promote(turn.runId) }
                                } label: {
                                    Image(systemName: "bolt.fill")
                                        .font(.system(size: 12))
                                        .foregroundStyle(Theme.text)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Send now — the running turn hears it without stopping")
                            }
                            Button {
                                Task { await store.withdraw(turn.runId) }
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(Theme.textMuted2)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove this queued message")
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Theme.subtle)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
    }

    private func submit() {
        guard canSend else { return }
        let text = draft
        draft = ""
        focused = false
        Task { await store.send(text) }
    }

    private func stop() {
        Task { await store.stopActiveTurn() }
    }

    /// TEXT ONLY, on the phone. The web also carries pictures; here an
    /// attachment is already uploaded to the session it was picked in, and
    /// re-uploading it elsewhere is the stash's next step, not this one. The
    /// attachments stay in the box and are named in the note so nothing
    /// looks lost.
    private func stashDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let ok = PromptStash.shared.stash(StashEntry(id: UUID().uuidString, at: Timestamp(Date().timeIntervalSince1970 * 1000), prompt: text, images: []))
        guard ok else {
            stashNote = "There was no room to stash this. Nothing was taken from the box."
            return
        }
        draft = ""
        stashNote = store.pendingAttachments.isEmpty ? nil : "Stashed the text. The photos stay here."
    }

    /// A RESTORE NEVER EATS WHAT IS ALREADY IN THE BOX.
    private func restore(_ entry: StashEntry) {
        guard let taken = PromptStash.shared.take(entry.id, room: 0) else { return }
        draft = StashRules.appendPrompt(draft, taken.prompt)
        stashNote = taken.left > 0 ? "\(taken.left == 1 ? "1 image is" : "\(taken.left) images are") still in the stash — this app cannot restore pictures yet." : nil
        focused = true
    }

    static let runtimeModes: [(String, String)] = [
        ("approval-required", "Supervised"),
        ("auto-accept-edits", "Auto-accept edits"),
        ("auto", "Auto"),
        ("full-access", "Full access"),
    ]
}

/// The collapsed pill's 44pt circular control: primary send at rest, danger
/// stop while running — the stop REPLACES send in the pill (t3's ControlPill).
struct ControlPillButton: View {
    let isRunning: Bool
    let canSend: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: isRunning ? "stop.fill" : "arrow.up")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(isRunning ? Theme.dangerGlyph : (canSend ? Theme.primaryGlyph : Theme.textMuted2))
                .frame(width: 44, height: 44)
                .background(isRunning ? Theme.dangerFill : (canSend ? Theme.primaryFill : Theme.subtleStrong))
                .clipShape(Circle())
        }
        .disabled(!isRunning && !canSend)
        .accessibilityLabel(isRunning ? "Stop the running turn" : "Send")
    }
}

/// A 44pt toolbar pill (t3's ComposerToolbarButton): subtle fill, hairline,
/// full radius; danger variant for stop.
struct ToolbarPill<Label: View>: View {
    enum Variant { case normal, danger }
    let variant: Variant
    let action: () -> Void
    @ViewBuilder let label: Label

    init(variant: Variant = .normal, action: @escaping () -> Void, @ViewBuilder label: () -> Label) {
        self.variant = variant
        self.action = action
        self.label = label()
    }

    var body: some View {
        Button(action: action) {
            label
                .foregroundStyle(variant == .danger ? Theme.dangerGlyph : Theme.text)
                .frame(width: 44, height: 44)
                .background(variant == .danger ? Theme.dangerFill : Theme.subtle)
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
        }
    }
}

extension View {
    /// t3's ComposerSurface: liquid glass on iOS 26+, an opaque near-material
    /// fallback elsewhere. Shadow belongs to the CALLER (a clipped surface
    /// would clip its own shadow).
    @ViewBuilder func composerGlass(cornerRadius: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        // `#available` guards the RUNTIME; the compiler gate guards the SDK —
        // a CI runner on an older Xcode has no `glassEffect` symbol at all,
        // and its builds fall to the opaque surface everywhere.
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular.interactive(), in: shape)
        } else {
            self.background(Theme.composerSurface)
                .clipShape(shape)
                .overlay(shape.strokeBorder(Theme.border, lineWidth: 1))
        }
        #else
        self.background(Theme.composerSurface)
            .clipShape(shape)
            .overlay(shape.strokeBorder(Theme.border, lineWidth: 1))
        #endif
    }
}
