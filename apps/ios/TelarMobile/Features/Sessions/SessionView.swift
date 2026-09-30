import SwiftUI

struct SessionView: View {
    @State private var store: SessionStore
    @State private var draft = ""
    @State private var height: CGFloat = 0

    @State private var composerFocused = false
    @State private var renaming = false
    @State private var renameDraft = ""

    @State private var panel: PanelModel

    @State private var inspectorShown = false
    @State private var pushShown = false
    @State private var fullScreenShown = false

    @State private var sidebarWasVisible = false

    @State private var seenDisplays: Set<Int> = []
    @State private var mountedAt = Timestamp(Date().timeIntervalSince1970 * 1000)
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.columnVisibility) private var columnVisibility

    @State private var position = ScrollPosition(edge: .bottom)

    @State private var isAtBottom = true
    private let api: any EngineAPI
    private let sessionId: EngineID
    private let hostId: HostID?

    private let hostName: String?
    private let hostCount: Int
    private let cockpitBaseURL: URL?

    @State private var receipt: ReadReceiptCourier?

    @State private var visibleReceiptRunId: EngineID?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss

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

        _store = State(initialValue: SessionStore(api: api, sessionId: sessionId, hostId: hostId, cache: cache))
        _panel = State(initialValue: PanelModel(hostId: hostId, sessionId: sessionId))
    }

    private var panelAPI: (any PanelAPI)? { api as? any PanelAPI }

    private var hostLabel: String? { HostLabel.header(name: hostName, hostCount: hostCount) }

    private var turnActive: Bool { store.hasActiveTurn }

    private var wantsColumn: Bool { sizeClass == .regular }

    private func raisePanel(_ open: Bool) {
        let (column, push) = PanelRaise.flags(open: open, wantsColumn: wantsColumn, fullScreen: panel.isFullScreen)
        if inspectorShown != column { inspectorShown = column }
        if pushShown != push { pushShown = push }
    }

    private func panelDismissed() {
        guard panel.isOpen else { return }
        panel.close()
    }

    private func syncSidebar(open: Bool) {
        guard sizeClass == .regular, let visibility = columnVisibility else { return }
        let width = UIScreen.main.bounds.width

        let roomForThree = width >= 300 + Theme.readingMeasure + 440

        let motion = Animation.easeInOut(duration: 0.28)
        if open, !roomForThree, visibility.wrappedValue != .detailOnly {
            sidebarWasVisible = true
            withAnimation(motion) { visibility.wrappedValue = .detailOnly }
        } else if !open, sidebarWasVisible {
            sidebarWasVisible = false
            withAnimation(motion) { visibility.wrappedValue = .all }
        }
    }

    private var visibleTurns: [JournalTurn] {
        transcriptTurns(store.sync.turns)
    }

    private var spokenSession: SpokenSession {
        SpokenSession(hostId: hostId, sessionId: sessionId)
    }

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

    private var showsJumpButton: Bool {
        position.isPositionedByUser && !isAtBottom
    }

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

                foreground: scenePhase == .active,

                atLatestResult: candidate != nil && visibleReceiptRunId == candidate?.runId,

                loading: store.sync.session == nil || store.sync.recordedAt != nil
            )
        )
    }

    var body: some View {
        presentations
            .navigationTitle(store.sync.session?.title ?? "Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .alert("Rename session", isPresented: $renaming) {
                TextField("Title", text: $renameDraft)
                Button("Rename") { Task { await store.rename(renameDraft) } }
                Button("Cancel", role: .cancel) {}
            }
    }

    private func panelView(_ presentation: PanelPresentation, canFillWindow: Bool) -> PanelView {
        PanelView(api: api, panelAPI: panelAPI, sessionId: sessionId, hostId: hostId, active: turnActive, panel: panel,
                  presentation: presentation, canFillWindow: canFillWindow, onClose: { panel.close() })
    }

    private var presentations: some View {
        presence
            .environment(\.panel, panel)
            .environment(\.kernelSignals, store.sync.kernelSignals)
            .inspector(isPresented: $inspectorShown) {
                NavigationStack {
                    panelView(.column, canFillWindow: true)
                        .toolbar(.hidden, for: .navigationBar)
                }

                .background(Theme.canvas)
                .inspectorColumnWidth(min: 360, ideal: 440, max: 640)
            }

            .fullScreenCover(isPresented: $fullScreenShown) {
                NavigationStack {
                    panelView(.page, canFillWindow: true)
                        .toolbar(.hidden, for: .navigationBar)
                        .background {
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

                if !shown, panel.isFullScreen { panel.setFullScreen(false) }
            }
            .navigationDestination(isPresented: $pushShown) {
                panelView(.page, canFillWindow: false)
                    .navigationTitle("Panel")
                    .navigationBarTitleDisplayMode(.inline)
            }
            .onChange(of: panel.isOpen, initial: true) { _, _ in

                raisePanel(panel.isOpen)
                syncSidebar(open: panel.isOpen)
            }
            .onChange(of: inspectorShown) { _, open in

                guard wantsColumn, !panel.isFullScreen, PanelRaise.isDismissal(open) else { return }
                panelDismissed()
            }
            .onChange(of: pushShown) { _, open in
                if !wantsColumn, PanelRaise.isDismissal(open) { panelDismissed() }
            }

            .onChange(of: wantsColumn) { raisePanel(panel.isOpen) }
            .task(id: "\(sessionId):plugins") { await readPlugins() }
            .onChange(of: panel.generation) {
                guard panel.isOpen else { return }
                raisePanel(true)
                syncSidebar(open: true)
            }
            .onChange(of: store.sync.displayOpens.count) { watchDisplayOpens() }
    }

    private var presence: some View {
        notices
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

                if phase == .active {
                    store.sync.start()
                    if let hostId { MobileNotifications.shared.visibleSession = .init(hostId: hostId, sessionId: sessionId) }
                } else { store.sync.stop(); MobileNotifications.shared.visibleSession = nil }
            }
            .onChange(of: store.sync.connection) { _, connection in
                if connection == .gone { dismiss() }
            }
    }

    private var notices: some View {
        polling
            .onAppear {
                if let hostId { MobileNotifications.shared.visibleSession = .init(hostId: hostId, sessionId: sessionId) }
            }
            .onChange(of: draft) { _, text in
                if let hostId { UserDefaults.standard.set(text, forKey: "telar.draft.\(hostId).\(sessionId)") }
            }

            .onChange(of: panel.pendingReference) { _, pending in
                guard let pending else { return }
                panel.clearReference()
                draft = ComposerReference.insert(pending, into: draft)

                if !wantsColumn || panel.isFullScreen { panel.close() }
                composerFocused = true
            }
            .alert("Live Activity", isPresented: Binding(get: { MobileNotifications.shared.activityError != nil }, set: { if !$0 { MobileNotifications.shared.activityError = nil } })) {
                Button("OK") { MobileNotifications.shared.activityError = nil }
            } message: { Text(MobileNotifications.shared.activityError ?? "") }
    }

    private var polling: some View {
        stack
            .task {
                store.sync.start()

                if receipt == nil {
                    let api = self.api
                    let sync = store.sync
                    let report = self.onRead
                    receipt = ReadReceiptCourier(
                        send: { identity, runId in try await api.markSessionRead(identity.sessionId, runId: runId) },

                        onRead: { identity, session in
                            sync.applyRead(session)
                            report?(session)

                            if let host = identity.hostId {
                                Task { await ReadSync.clearDelivered([ScopedSessionID(hostId: host, sessionId: identity.sessionId)]) }
                            }
                        }
                    )
                    sendReceiptIfEarned()
                }
            }
            .onChange(of: receiptWorld) { sendReceiptIfEarned() }
    }

    private var stack: some View {
        VStack(spacing: 0) {
            statusStrip
            transcript
            footer
        }
        .background(Theme.canvas)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
    }

    @ViewBuilder private var statusStrip: some View {
        if let session = store.sync.session {
            HStack(spacing: 6) {
                ActivityBadge(activity: session.activity)
                Text(session.activity == .blocked ? "Needs you" : session.activity.rawValue.capitalized)
                Spacer()

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
    }

    private var transcript: some View {
        ScrollView {
            VStack(spacing: 0) {
                if store.sync.hasOlderTurns {
                    loadEarlierButton
                }

                TranscriptView(
                    turns: visibleTurns,
                    receiptMarker: receiptWorld.candidate?.runId,
                    onReceiptMarkerVisible: { runId, visible in

                        if visible { visibleReceiptRunId = runId }
                        else if visibleReceiptRunId == runId { visibleReceiptRunId = nil }
                    }
                )
                .readingColumn()
                .padding(.vertical, 12)
            }
        }
        .scrollPosition($position)

        .scrollDismissesKeyboard(.immediately)

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

        .onChange(of: visibleTurns.isEmpty) { _, isEmpty in
            guard !isEmpty else { return }
            followTail()
        }
        .onChange(of: contentFingerprint) { followTail() }

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
    }

    private func readPlugins() async {
        guard let panelAPI else { return }
        var projectId = store.sync.session?.projectId
        if projectId == nil {
            projectId = (try? await api.session(sessionId, window: SnapshotWindow(turns: 1)))?.session.projectId
        }
        guard let projectId, let projects = try? await panelAPI.projects(), let project = projects.first(where: { $0.id == projectId }) else { return }
        panel.setPlugins(project.enabledPlugins)
    }

    private func watchDisplayOpens() {
        let fresh = store.sync.displayOpens.filter { $0.at >= mountedAt && !seenDisplays.contains($0.id) }
        guard !fresh.isEmpty else { return }
        for open in fresh { seenDisplays.insert(open.id) }
        if let last = fresh.last { panel.openFile(last.path) }
    }

    private func sendReceiptIfEarned() {
        let world = receiptWorld
        receipt?.update(identity: world.identity, candidate: world.candidate, readSequence: world.readSequence, gate: world.gate)
    }

    private func followTail() {
        guard TranscriptFollow.shouldFollow(takenByReader: position.isPositionedByUser, atBottom: isAtBottom) else { return }
        pinToTail()
    }

    private func pinToTail() {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            position.scrollTo(edge: .bottom)
        }
    }

    private var loadEarlierButton: some View {
        Button {
            Task { await store.sync.loadOlderTurns() }
        } label: {
            Text(store.sync.loadingOlder ? "Loading earlier turns…" : "Load earlier turns")
                .font(.system(Theme.footnote, weight: .medium))
                .foregroundStyle(Theme.textMuted)
                .padding(.horizontal, 14)
                .scaledHeight(32, relativeTo: .footnote)
                .background(Theme.subtle)
                .clipShape(Capsule())
                .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(store.sync.loadingOlder)
        .padding(.top, 12)
    }

    private func jumpToBottomButton() -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.2)) {
                position.scrollTo(edge: .bottom)
            }
        } label: {
            Image(systemName: "arrow.down")
                .foregroundStyle(Theme.text)
                .scaledGlyphBox(36, glyph: 14, weight: .semibold)
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

    @ViewBuilder private var footer: some View {
        VStack(spacing: 12) {
            if case .retrying(let message) = store.sync.connection {
                StatusCard(tint: Theme.statusAmber) {
                    HStack(spacing: 6) {
                        Image(systemName: "wifi.exclamationmark").font(.system(Theme.caption))

                        Text(store.sync.recordedAt.map { "Showing what was recorded at \(recordedAtLabel($0)) — reconnecting…" } ?? message)
                            .font(.system(Theme.footnote)).lineLimit(2)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Theme.statusAmber)
                }
            }
            ForEach(store.sync.openRequests) { request in
                StatusCard(tint: Theme.statusAmber) {
                    RequestCardView(request: request, store: store, maxHeight: height > 0 ? height * 0.58 : .infinity)
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
            ComposerView(
                draft: $draft,
                focus: $composerFocused,
                host: SessionComposerHost(store: store),

                api: store.api,
                controls: SessionComposerControls.make(store: store),
                onSend: { pinToTail() }
            )
        }
        .padding(.horizontal, 16)
        .readingColumn(gutter: Theme.readingGutter)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(alignment: .bottom) { ComposerScrim() }
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
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
