import SwiftUI
import PhotosUI

struct SessionView: View {
    @State private var store: SessionStore
    @State private var draft = ""
    /// The composer's focus, held here so the transcript can drop it — see
    /// the ScrollView below and `ComposerView.focus`.
    @State private var composerFocused = false
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
    @State private var fullScreenShown = false
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
    /// WHICH MAC THIS CONVERSATION IS ON, and how many this phone knows —
    /// issue #244. The two facts rather than the settings store because that is
    /// all the strip needs, and `HostLabel.header` is what turns them into the
    /// label (or into nothing). Passed rather than looked up: this view knows
    /// an API and a session id, and has never held a host book.
    private let hostName: String?
    private let hostCount: Int
    private let cockpitBaseURL: URL?
    /// THE READ RECEIPT — see Stores/ReadReceipt.swift for why the phone needs
    /// one at all. Built in `.task` rather than in `init`, because it reaches
    /// back into the store this view owns and `init` runs on every parent
    /// re-render.
    @State private var receipt: ReadReceiptCourier?
    /// WHICH answer's marker is on screen — not whether one is. A boolean would
    /// carry the old answer's "yes" into a new one's first render, confirming a
    /// turn nobody had seen yet.
    @State private var visibleReceiptRunId: EngineID?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss

    /// Told when the engine confirms a read, with the session as it answered.
    ///
    /// THE SIDEBAR IS THE OTHER SURFACE SHOWING THE DOT, and it polls its own
    /// list — so without this the row kept its dot until the next poll, which
    /// on the iPad (sidebar and transcript on screen at once) meant the reader
    /// watched it outlive the read by up to ten seconds. A closure rather than
    /// an environment value because there is exactly one caller and one fact to
    /// hand it; the view still knows nothing about an inbox.
    private let onRead: ((Session) -> Void)?

    init(
        api: any EngineAPI, sessionId: EngineID, hostId: HostID? = nil,
        hostName: String? = nil, hostCount: Int = 1,
        cockpitBaseURL: URL? = nil, cache: HostSnapshotCache? = nil,
        onRead: ((Session) -> Void)? = nil
    ) {
        self.api = api
        self.sessionId = sessionId
        self.hostId = hostId
        self.hostName = hostName
        self.hostCount = hostCount
        self.cockpitBaseURL = cockpitBaseURL
        self.onRead = onRead
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

    /// The Mac's name for the strip, or nothing when naming it would say
    /// nothing. `HostLabel` holds the rule; see it for why one paired Mac is
    /// silent and why this surface, unlike a rail row, never defers to context.
    private var hostLabel: String? { HostLabel.header(name: hostName, hostCount: hostCount) }

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
        let (column, push) = PanelRaise.flags(open: open, wantsColumn: wantsColumn, fullScreen: panel.isFullScreen)
        if inspectorShown != column { inspectorShown = column }
        if pushShown != push { pushShown = push }
    }

    /// The other direction, and ONLY that direction: the reader closed the
    /// column or popped the push. A presentation raising its own flag is this
    /// view's own write echoing — see `PanelRaise` for the ring it closed.
    private func panelDismissed() {
        guard panel.isOpen else { return }
        panel.close()
    }

    /// There is room for sidebar, transcript and panel only in landscape, so
    /// opening the panel hides the sidebar when the window is narrower than
    /// all three need, and closing it puts the sidebar back if it was there.
    private func syncSidebar(open: Bool) {
        guard sizeClass == .regular, let visibility = columnVisibility else { return }
        let width = UIScreen.main.bounds.width
        // The sidebar is a fixed 300 (see `navigationSplitViewColumnWidth`),
        // so this is an exact question rather than an estimate.
        let roomForThree = width >= 300 + Theme.readingMeasure + 440
        // NAMED AND SLOWER THAN THE DEFAULT. The sidebar leaving is a column
        // disappearing and the conversation re-centring in what is left; at
        // the default spring that reads as a jump rather than as room being
        // made.
        let motion = Animation.easeInOut(duration: 0.28)
        if open, !roomForThree, visibility.wrappedValue != .detailOnly {
            sidebarWasVisible = true
            withAnimation(motion) { visibility.wrappedValue = .detailOnly }
        } else if !open, sidebarWasVisible {
            sidebarWasVisible = false
            withAnimation(motion) { visibility.wrappedValue = .all }
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

    /// Which session speech is about, when this one is asked to read a reply
    /// aloud. See Speech/Talkback.swift for why it carries the host too.
    private var spokenSession: SpokenSession {
        SpokenSession(hostId: hostId, sessionId: sessionId)
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

    /// Everything the receipt rule reads, as one Equatable value — so the
    /// courier is re-evaluated when any of it moves and NOT once per poll tick
    /// that changed nothing it cares about.
    private struct ReceiptWorld: Equatable {
        var identity: ReceiptIdentity?
        var candidate: ReceiptTurn?
        var readSequence: Int?
        var gate: ReceiptGate
    }

    private var receiptWorld: ReceiptWorld {
        let candidate = newestResultTurn(
            visibleTurns.map { ReceiptTurn(runId: $0.runId, state: $0.state, sequence: $0.sequence) }
        )
        return ReceiptWorld(
            identity: store.sync.session == nil ? nil : ReceiptIdentity(sessionId: sessionId, hostId: hostId),
            candidate: candidate,
            readSequence: store.sync.session?.lastReadTurnSequence,
            gate: ReceiptGate(
                // A phone has one window, so the scene phase IS "is somebody
                // looking": backgrounded, in the switcher, and under a locked
                // screen are all somebody elsewhere.
                foreground: scenePhase == .active,
                // The candidate's OWN marker, never a previous answer's.
                atLatestResult: candidate != nil && visibleReceiptRunId == candidate?.runId,
                // NEVER BEFORE THE MAC HAS ANSWERED, and never off a
                // PHOTOGRAPH: `recordedAt` means this transcript came out of
                // the snapshot cache because the Mac is away, so the sequences
                // on screen are as old as the picture and confirming them would
                // claim a read of whatever has happened since.
                loading: store.sync.session == nil || store.sync.recordedAt != nil
            )
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            if let session = store.sync.session {
                HStack(spacing: 6) {
                    ActivityBadge(activity: session.activity)
                    Text(session.activity == .blocked ? "Needs you" : session.activity.rawValue.capitalized)
                    Spacer()
                    // WHICH MAC THIS CONVERSATION IS ON — issue #244, and the
                    // one fact the transcript could never supply. The title
                    // above it is a name somebody chose, the branch beside it
                    // is a name somebody chose, and two paired Macs can carry
                    // the same of either; the machine is what tells them apart.
                    //
                    // TRAILING, BESIDE THE BRANCH, because the strip is already
                    // read as two halves: what this conversation is DOING on the
                    // leading edge, and WHERE its work lands on the trailing
                    // one. The Mac is the outermost "where", so it sits just
                    // outside the branch rather than interrupting the status.
                    //
                    // IT CARRIES A GLYPH, unlike the rail's badge. There the
                    // shape is learned from company — a header's list of them,
                    // rows above and below wearing the same mark. Here there is
                    // exactly one, next to a branch name, and a bare rounded
                    // rectangle would be a second piece of text to decode.
                    if let hostLabel {
                        HStack(spacing: 3) {
                            Image(systemName: "desktopcomputer").font(.system(Theme.captionTiny))
                            Text(hostLabel).lineLimit(1).truncationMode(.tail)
                        }
                        .padding(.horizontal, 4)
                        .background(Theme.subtle, in: RoundedRectangle(cornerRadius: 3))
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("On \(hostLabel)")
                    }
                    Text(session.workspace.branch ?? session.driver).lineLimit(1)
                }
                .font(.caption).foregroundStyle(Theme.textMuted).padding(.horizontal, 16).padding(.vertical, 8)
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
                    TranscriptView(
                        turns: visibleTurns,
                        receiptMarker: receiptWorld.candidate?.runId,
                        onReceiptMarkerVisible: { runId, visible in
                            // Only ever claims or releases ITS OWN run, so a
                            // marker unmounting cannot blank the answer that
                            // replaced it.
                            if visible { visibleReceiptRunId = runId }
                            else if visibleReceiptRunId == runId { visibleReceiptRunId = nil }
                        }
                    )
                    .readingColumn()
                    .padding(.vertical, 12)
                }
            }
            .scrollPosition($position)
            // THE CONVERSATION IS THE WAY OUT OF THE KEYBOARD. A tap on it, or
            // scrolling it, puts the keyboard away — what every messaging app
            // does, and the phone offered neither: the only exits were Send
            // and the return key. `.immediately` rather than `.interactively`
            // because scrolling UP to re-read is the common case, and the
            // interactive mode only dismisses on a drag toward the keyboard.
            // Buttons, links and long-presses inside the transcript still win;
            // this catches only the tap nothing else wanted.
            .scrollDismissesKeyboard(.immediately)
            // AND THE SCROLL HALF, SAID OURSELVES. `.scrollDismissesKeyboard`
            // works through SwiftUI's own focus, and the composer's field is a
            // `UITextView` — outside that system, so the modifier alone scrolled
            // the transcript with the keyboard still standing. `.interacting` is
            // the finger on the glass, which is what `.immediately` means.
            .onScrollPhaseChange { _, phase in
                if phase == .interacting, composerFocused { composerFocused = false }
            }
            .onTapGesture { composerFocused = false }
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
            // AND AS THE REVEAL PAINTS IT, not only as it arrives.
            // `contentFingerprint` counts the RAW `streamedText`, so it moves
            // when a poll lands — before the pacer has drawn a character of it.
            // The height then grows for about a second with nothing re-pinning,
            // and the last chunk of a reply has no arrival after it to correct
            // the drift. Height is the signal that matches what the reader
            // sees; re-pinning moves the offset, never the height, so this
            // cannot feed itself.
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.contentSize.height
            } action: { _, _ in
                followTail()
            }
            .overlay(alignment: .bottomTrailing) {
                jumpToBottomButton()
                    .opacity(showsJumpButton ? 1 : 0)
                    .allowsHitTesting(showsJumpButton)
                    .animation(.easeInOut(duration: 0.15), value: showsJumpButton)
            }
            footer
        }
        .background(Theme.canvas)
        .task {
            store.sync.start()
            // One courier for the life of the mount. It owns an in-flight
            // request and a dwell timer, so it is a subscription rather than a
            // derived value — rebuilding it per render would lose both.
            if receipt == nil {
                let api = self.api
                let sync = store.sync
                let report = self.onRead
                receipt = ReadReceiptCourier(
                    send: { identity, runId in try await api.markSessionRead(identity.sessionId, runId: runId) },
                    // BOTH SURFACES, from the one answer. The transcript's own
                    // copy stops the gate re-firing; the report is what puts the
                    // sidebar's row right without waiting for its poll.
                    onRead: { _, session in
                        sync.applyRead(session)
                        report?(session)
                    }
                )
                sendReceiptIfEarned()
            }
        }
        .onChange(of: receiptWorld) { sendReceiptIfEarned() }
        .onAppear {
            if let hostId { MobileNotifications.shared.visibleSession = .init(hostId: hostId, sessionId: sessionId) }
        }
        .onChange(of: draft) { _, text in
            if let hostId { UserDefaults.standard.set(text, forKey: "telar.draft.\(hostId).\(sessionId)") }
        }
        // "INSERT AS A REFERENCE", from wherever it was picked. The tree, the
        // file body, a transcript row and a diff row all reach the composer
        // through the panel model they already share; this is the other end.
        .onChange(of: panel.pendingReference) { _, pending in
            guard let pending else { return }
            panel.clearReference()
            draft = ComposerReference.insert(pending, into: draft)
            // THE BOX IT LANDED IN HAS TO BE ON SCREEN. Beside the transcript
            // the composer already is; as a push or filling the window the
            // panel is covering it, and an insert with nothing to show for it
            // reads as a menu item that did nothing.
            if !wantsColumn || panel.isFullScreen { panel.close() }
            composerFocused = true
        }
        .onChange(of: store.sync.session) { _, session in
            if let session, let hostId { Task { await MobileNotifications.shared.update(session, hostId: hostId) } }
        }
        .alert("Live Activity", isPresented: Binding(get: { MobileNotifications.shared.activityError != nil }, set: { if !$0 { MobileNotifications.shared.activityError = nil } })) {
            Button("OK") { MobileNotifications.shared.activityError = nil }
        } message: { Text(MobileNotifications.shared.activityError ?? "") }

        .onDisappear {
            store.sync.stop()
            receipt?.dispose()
            receipt = nil
            if MobileNotifications.shared.visibleSession?.sessionId == sessionId && MobileNotifications.shared.visibleSession?.hostId == hostId {
                MobileNotifications.shared.visibleSession = nil
            }
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
            } else { store.sync.stop(); MobileNotifications.shared.visibleSession = nil }
        }
        .onChange(of: store.sync.connection) { _, connection in
            if connection == .gone { dismiss() }
        }
        .environment(\.panel, panel)
        .environment(\.kernelSignals, store.sync.kernelSignals)
        .inspector(isPresented: $inspectorShown) {
            NavigationStack {
                PanelView(api: api, panelAPI: panelAPI, sessionId: sessionId, hostId: hostId, active: turnActive, panel: panel, presentation: .column, canFillWindow: true, onClose: { panel.close() })
                    .toolbar(.hidden, for: .navigationBar)
            }
            // The card draws its own surface, so the column behind it is the
            // canvas the conversation sits on rather than a second sheet.
            .background(Theme.canvas)
            .inspectorColumnWidth(min: 360, ideal: 440, max: 640)
        }
        // FULL SCREEN IS THE SAME VIEW WITH THE SCREEN TO ITSELF. `PanelModel`
        // owns the state, so the tab, the open files and their unsaved drafts
        // cross unchanged — nothing is handed to a second instance.
        //
        // Its flag is `@State` for the reason every presentation flag here is:
        // a `Binding` built in `body` is a new location on every pass, and
        // `.fullScreenCover` compares the one it was given.
        .fullScreenCover(isPresented: $fullScreenShown) {
            NavigationStack {
                PanelView(api: api, panelAPI: panelAPI, sessionId: sessionId, hostId: hostId, active: turnActive, panel: panel, presentation: .page, canFillWindow: true, onClose: { panel.close() })
                    .toolbar(.hidden, for: .navigationBar)
                    .background {
                        // A hardware Escape leaves full screen, the way it
                        // leaves one on every other platform. Zero-sized so it
                        // is a shortcut and not a control.
                        Button("") { panel.setFullScreen(false) }
                            .keyboardShortcut(.escape, modifiers: [])
                            .opacity(0)
                            .accessibilityHidden(true)
                    }
            }
        }
        .onChange(of: panel.isFullScreen, initial: true) { _, full in
            let wanted = full && wantsColumn
            if fullScreenShown != wanted { fullScreenShown = wanted }
            raisePanel(panel.isOpen)
        }
        .onChange(of: fullScreenShown) { _, shown in
            // The cover was pulled down by a gesture rather than the button.
            if !shown, panel.isFullScreen { panel.setFullScreen(false) }
        }
        .navigationDestination(isPresented: $pushShown) {
            PanelView(api: api, panelAPI: panelAPI, sessionId: sessionId, hostId: hostId, active: turnActive, panel: panel, onClose: { panel.close() })
                .navigationTitle("Panel")
                .navigationBarTitleDisplayMode(.inline)
        }
        .onChange(of: panel.isOpen, initial: true) { _, _ in
            // THE MODEL AS IT IS NOW, never the value the change carried.
            // `isOpen` can flip twice inside one update pass, and SwiftUI then
            // delivers the superseded one too; raising the push off THAT put
            // `pushShown` back up for a frame against a panel already closed.
            raisePanel(panel.isOpen)
            syncSidebar(open: panel.isOpen)
        }
        .onChange(of: inspectorShown) { _, open in
            // THE COLUMN CLOSING BECAUSE WE WENT FULL SCREEN IS NOT THE READER
            // CLOSING THE PANEL. Without this guard, expanding read as a
            // dismissal: `panel.close()` ran, which also drops full screen, and
            // the whole thing collapsed instead of filling the window.
            guard wantsColumn, !panel.isFullScreen, PanelRaise.isDismissal(open) else { return }
            panelDismissed()
        }
        .onChange(of: pushShown) { _, open in
            if !wantsColumn, PanelRaise.isDismissal(open) { panelDismissed() }
        }
        // A rotation or a multitasking resize moves the panel between the
        // column and the push; the model says whether it is showing at all.
        .onChange(of: wantsColumn) { raisePanel(panel.isOpen) }
        .task(id: "\(sessionId):plugins") { await readPlugins() }
        .onChange(of: panel.generation) {
            // A file opened from a chip or a `display.opened` event: make
            // sure the panel is showing and the sidebar has made room.
            //
            // THE RAISE BELONGS HERE TOO, not only on `isOpen`. A panel the
            // model already calls open flips nothing for that watcher to fire
            // on, so at a compact width — where the panel is a push and not a
            // column — the agent's file landed in a panel that never came up.
            // `generation` goes up on every open, which is the one signal that
            // survives the panel already being open.
            guard panel.isOpen else { return }
            raisePanel(true)
            syncSidebar(open: true)
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
    /// through the engine's own rule — the plugin map when the project carries
    /// its marker, the legacy blocks only when it never has. Off until known.
    private func readPlugins() async {
        guard let panelAPI else { return }
        var projectId = store.sync.session?.projectId
        if projectId == nil {
            projectId = (try? await api.session(sessionId, window: SnapshotWindow(turns: 1)))?.session.projectId
        }
        guard let projectId, let projects = try? await panelAPI.projects(), let project = projects.first(where: { $0.id == projectId }) else { return }
        panel.setPlugins(dataScience: project.pluginEnabled(.dataScience), latex: project.pluginEnabled(.latex))
    }

    /// The agent asked the cockpit to show a file. Only events newer than
    /// this mount count, and each only once.
    private func watchDisplayOpens() {
        let fresh = store.sync.displayOpens.filter { $0.at >= mountedAt && !seenDisplays.contains($0.id) }
        guard !fresh.isEmpty else { return }
        for open in fresh { seenDisplays.insert(open.id) }
        if let last = fresh.last { panel.openFile(last.path) }
    }

    /// Hand the courier the current world. It decides whether anything is owed
    /// and holds the gate for a beat before sending — see ReadReceipt.swift.
    private func sendReceiptIfEarned() {
        let world = receiptWorld
        receipt?.update(identity: world.identity, candidate: world.candidate, readSequence: world.readSequence, gate: world.gate)
    }

    /// Re-pin to the tail, unless the reader has scrolled away and stayed
    /// away — scrolled away means scrolled away, and nothing here yanks them
    /// back. Coming back to the end re-arms it; see `TranscriptFollow` for why
    /// that second half had to exist.
    private func followTail() {
        guard TranscriptFollow.shouldFollow(takenByReader: position.isPositionedByUser, atBottom: isAtBottom) else { return }
        pinToTail()
    }

    /// The tail, unconditionally — for the moments that ARE the reader asking
    /// for the end rather than content arriving on its own.
    ///
    /// No animation: following should read as content growing under a fixed
    /// viewport, and an animation per delta is what made it visibly pump.
    /// Setting the position also clears `isPositionedByUser`, which is how a
    /// reader who scrolled earlier gets their follow back.
    private func pinToTail() {
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
                .font(.system(Theme.footnote, weight: .medium))
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
                        Image(systemName: "wifi.exclamationmark").font(.system(Theme.caption))
                        // WHAT IS ON SCREEN, when it is the phone's own copy:
                        // the transcript stays, and the card says how old it
                        // is instead of pretending it is the Mac's answer.
                        Text(store.sync.recordedAt.map { "Showing what was recorded at \(recordedAtLabel($0)) — reconnecting…" } ?? message)
                            .font(.system(Theme.footnote)).lineLimit(2)
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
                            .font(.system(Theme.footnote))
                            .foregroundStyle(Theme.statusRed)
                            .lineLimit(2)
                        Spacer(minLength: 0)
                        Button("Retry") { Task { await store.retryPending() } }
                            .font(.system(Theme.footnote, weight: .medium))
                            .foregroundStyle(Theme.text)
                            .buttonStyle(.plain)
                        Button("Discard") { store.discardPending() }
                            .font(.system(Theme.footnote, weight: .medium))
                            .foregroundStyle(Theme.statusRed)
                            .buttonStyle(.plain)
                    }
                }
            }
            ComposerView(draft: $draft, focus: $composerFocused, store: store, onSend: { pinToTail() })
        }
        .padding(.horizontal, 16)
        .readingColumn(gutter: Theme.readingGutter)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(alignment: .bottom) { ComposerScrim() }
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        // THE PANEL'S OWN CONTROL, opposite the sidebar's. Reaching the panel
        // meant opening the overflow menu and choosing from it — two taps and
        // a memory, for the thing on the other side of the screen from a
        // sidebar button that is always there. This mirrors it: same glyph
        // family, same placement logic, and it is lit while the panel is up so
        // the button says which state you are in rather than only what it does.
        //
        // Regular width only. On a compact one the panel is a full-screen push
        // and the menu's "Panel" and "Changes" items are the way in; a toolbar
        // toggle for something that covers the screen reads as a trap.
        if wantsColumn {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    panel.toggle()
                } label: {
                    Image(systemName: "sidebar.trailing")
                        .foregroundStyle(panel.isOpen ? Theme.accent : Theme.textMuted)
                }
                .accessibilityLabel(panel.isOpen ? "Hide panel" : "Show panel")
                .accessibilityAddTraits(panel.isOpen ? .isSelected : [])
                // Cmd-Option-I for the inspector, beside the sidebar's
                // Cmd-Option-0. The other three (Cmd-N, Cmd-S, Cmd-,) are
                // spoken for elsewhere.
                .keyboardShortcut("i", modifiers: [.command, .option])
            }
        }
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
                // READ IT TO ME. The item is here rather than on the message
                // because a control on the last reply is a control on EVERY
                // reply, drawn to serve one — and this menu is already where
                // the session's verbs live.
                if Talkback.shared.isSpeaking(spokenSession) {
                    Button("Stop speaking", systemImage: "speaker.slash") {
                        Talkback.shared.stop()
                    }
                } else if let source = lastReplySource(of: visibleTurns) {
                    Button("Speak the last reply", systemImage: "speaker.wave.2") {
                        Talkback.shared.speak(speakableText(source), for: spokenSession)
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
    /// FOCUS LIVES A STRUCT UP. The transcript is what puts the keyboard away
    /// (a tap on it, or a scroll), and it cannot reach a flag that is private
    /// here — so the session owns it and the composer binds to it. Reads keep
    /// the old name below; writes go through the binding.
    ///
    /// PLAIN STATE, NOT `@FocusState`: the field is a `UITextView` now, and
    /// SwiftUI's focus system has no view of its own to move focus to. The
    /// field mirrors its first-responder state into this flag instead.
    let focus: Binding<Bool>
    let store: SessionStore
    /// SENDING ALWAYS GOES TO THE END. The transcript's scroll lives a struct
    /// up, so the composer says "sent" and the transcript decides what that
    /// means for the viewport — the box has no business knowing about pins.
    var onSend: () -> Void = {}

    private var focused: Bool { focus.wrappedValue }
    @State private var managingQueue = false
    @State private var pickedPhotos: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    @State private var showingStash = false
    /// What just happened to the box — a stash, or a file turned away.
    @State private var note: String?
    @State private var dropping = false
    @Environment(\.colorScheme) private var scheme

    private var isRunning: Bool { store.hasRunningTurn }
    private var queued: [JournalTurn] { store.queuedTurns }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !store.pendingAttachments.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            if let note {
                Text(note)
                    .font(.system(Theme.footnote))
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
                // A UIKit field, so that the system's own Paste offers a
                // picture at all — see ComposerTextView.
                ComposerTextView(
                    text: $draft,
                    placeholder: "Ask the agent, or run a command…",
                    focused: focus,
                    maxLines: focused ? 7 : 1,
                    onPaste: { intake($0) }
                )
                .frame(minHeight: focused ? 80 : 44, alignment: focused ? .topLeading : .leading)
                .padding(.vertical, focused ? 8 : 0)
                if !focused {
                    if !store.pendingAttachments.isEmpty {
                        Text("+\(store.pendingAttachments.count)")
                            .font(.system(Theme.footnote, weight: .bold))
                            .foregroundStyle(Theme.textMuted)
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
        .composerGlass(cornerRadius: focused ? Theme.radiusComposerFocused : Theme.radiusComposerRest)
        .shadow(color: .black.opacity(scheme == .dark ? 0.35 : 0.12), radius: 14, y: 6)
        // THE WHOLE PILL IS THE TARGET, its margins included. The glass used
        // to make the padding hit-testable as a side effect of wrapping the
        // box; behind it, a tap beside the text would fall through to the
        // transcript — which dismisses the keyboard.
        .contentShape(RoundedRectangle(cornerRadius: focused ? Theme.radiusComposerFocused : Theme.radiusComposerRest, style: .continuous))
        .onTapGesture { focus.wrappedValue = true }
        // THE BOX'S OWN MENU — the desktop's `ComposerChromeMenu`. Remove
        // attachment lives on the chip that has one (see `AttachmentChip`), so
        // what is left here are the two verbs about the draft itself. Clearing
        // is the one with no other affordance at all: stashing has the tray.
        .contextMenu {
            Button("Clear draft", systemImage: "eraser") { clearDraft() }
                .disabled(draft.isEmpty)
            Button("Stash draft", systemImage: "tray.and.arrow.down", action: stashDraft)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        // DRAG FROM FILES OR PHOTOS, which on an iPad is how a second app
        // hands something over. `.onDrop` rather than `.dropDestination`: a
        // provider carries its own registered types, which is what decides
        // whether the bytes or a sandboxed URL are worth loading.
        .onDrop(of: ComposerIntake.accepted, isTargeted: $dropping) { providers in
            intake(providers)
            return true
        }
        .overlay {
            if dropping {
                RoundedRectangle(cornerRadius: focused ? Theme.radiusComposerFocused : Theme.radiusComposerRest, style: .continuous)
                    .strokeBorder(Theme.accent, lineWidth: 2)
            }
        }
    }

    /// ONE PATH FOR BOTH. A paste and a drop deliver the same item providers,
    /// and both end at the upload the picker already uses. A refusal is said
    /// out loud above the composer — a file that simply never appears reads as
    /// the app being broken.
    private func intake(_ providers: [NSItemProvider]) {
        Task {
            let (files, refusals) = await composerFiles(from: providers)
            for file in files {
                await store.attach(data: file.data, name: file.name, mediaType: file.mediaType)
            }
            note = refusals.isEmpty ? nil : refusals.joined(separator: " ")
        }
    }

    /// 72×72 radius-16 thumbs with a 22pt dark remove circle — the expanded
    /// card's strip. Files aren't previewable images here; the name carries.
    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(store.pendingAttachments) { attachment in
                    AttachmentChip(
                        name: attachment.name,
                        mediaType: attachment.mediaType,
                        preview: store.attachmentPreviews[attachment.id],
                        onRemove: { store.removeAttachment(attachment.id) }
                    )
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
                    // NO PASTE CONTROL HERE ANY MORE. A screenshot on the
                    // clipboard goes in through the field's own Paste, which
                    // is where a person looks for it.
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
                    .foregroundStyle(canSend ? Theme.primaryGlyph : Theme.textMuted)
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
                        .font(.system(Theme.footnote))
                        .foregroundStyle(Theme.textMuted)
                }
            }
            .buttonStyle(.plain)
            if managingQueue {
                ForEach(queued) { turn in
                    let sending = turn.state == .steering
                    HStack(spacing: 10) {
                        Text(turn.prompt)
                            .font(.system(Theme.footnote))
                            .foregroundStyle(Theme.text)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if sending {
                            Text("sending")
                                .font(.system(Theme.caption, weight: .medium))
                                .textCase(.uppercase)
                                .foregroundStyle(Theme.statusSky)
                        } else {
                            if isRunning && store.sync.session?.driver != "opencode" {
                                Button {
                                    Task { await store.promote(turn.runId) }
                                } label: {
                                    Image(systemName: "bolt.fill")
                                        .font(.system(Theme.footnote))
                                        .foregroundStyle(Theme.text)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Send now — the running turn hears it without stopping")
                            }
                            Button {
                                Task { await store.withdraw(turn.runId) }
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(Theme.caption, weight: .medium))
                                    .foregroundStyle(Theme.textMuted)
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
        focus.wrappedValue = false
        // Whatever the scroll believed. Nothing here used to touch it, so a
        // message sent after reading back through the transcript landed off
        // screen and the conversation looked frozen. Unconditional, unlike
        // `followTail` — you wrote it, so you are going to it.
        onSend()
        Task { await store.send(text) }
    }

    private func stop() {
        Task { await store.stopActiveTurn() }
    }

    /// The whole box, emptied — the one thing the composer could not do
    /// without selecting everything and deleting it by hand. ATTACHMENTS ARE
    /// NOT THE DRAFT: each chip carries its own remove, and clearing the text
    /// must not quietly take the picture off the message too.
    private func clearDraft() {
        guard !draft.isEmpty else { return }
        draft = ""
        note = nil
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
            note = "There was no room to stash this. Nothing was taken from the box."
            return
        }
        draft = ""
        note = store.pendingAttachments.isEmpty ? nil : "Stashed the text. The photos stay here."
    }

    /// A RESTORE NEVER EATS WHAT IS ALREADY IN THE BOX.
    private func restore(_ entry: StashEntry) {
        guard let taken = PromptStash.shared.take(entry.id, room: 0) else { return }
        draft = StashRules.appendPrompt(draft, taken.prompt)
        note = taken.left > 0 ? "\(taken.left == 1 ? "1 image is" : "\(taken.left) images are") still in the stash — this app cannot restore pictures yet." : nil
        focus.wrappedValue = true
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
                .foregroundStyle(isRunning ? Theme.dangerGlyph : (canSend ? Theme.primaryGlyph : Theme.textMuted))
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
            // BEHIND THE PILL, NOT AROUND IT. `glassEffect` applied to the
            // composer swallowed every touch bound for the field inside it —
            // tapping the box did nothing at all, no caret and no keyboard.
            // SwiftUI's own controls are routed through the glass; a
            // `UIViewRepresentable` is not, and the field is one now. As a
            // background that answers no touches it draws the same material
            // and the pill takes taps again. (`.interactive()` is gone with
            // it: a layer nothing can touch cannot respond to being touched.)
            //
            // THE CARD HAS ITS OWN BODY UNDER THE GLASS. Liquid glass samples
            // whatever is behind it, and the transcript scrolls under the
            // composer — so the last line read through the card's top edge at
            // reduced contrast. The fill is what the glass samples now, and
            // the glass is left to tint the rim. 0.85 rather than 1 so it
            // still reads as a material and not as an opaque bar.
            self.background {
                ZStack {
                    shape.fill(Theme.composerSurface.opacity(0.85))
                    Color.clear.glassEffect(.regular, in: shape)
                }
                .allowsHitTesting(false)
            }
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
