import SwiftUI

@main
struct TelarMobileApp: App {
    @UIApplicationDelegateAdaptor(MobileAppDelegate.self) private var delegate
    @State private var settings: AppSettings
    init() {
        #if DEBUG
        if let raw = UserDefaults.standard.string(forKey: "mobilePreviewURL"), let url = URL(string: raw),
           url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host ?? "") {
            let defaults = UserDefaults(suiteName: "telar.mobile.preview")!
            let host = Host(id: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!, name: "Studio Mac", baseURLString: raw)
            HostMigration.persist(HostBook(hosts: [host]), defaults: defaults)
            let preview = AppSettings(defaults: defaults, vault: MemoryVault())
            preview.snapshots = nil
            _settings = State(initialValue: preview)
            return
        }
        #endif
        let settings = AppSettings()
        _settings = State(initialValue: settings)
        MobileNotifications.shared.start(settings: settings)
    }
    var body: some Scene {
        WindowGroup { RootView(settings: settings).tint(Theme.accent) }
    }
}

struct RootView: View {
    let settings: AppSettings
    @State private var inbox = MergedInbox()
    @State private var composing: Composing?
    @State private var selection: ScopedSessionID?
    @State private var showSettings = UserDefaults.standard.bool(forKey: "openSettings")
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var preferredColumn: NavigationSplitViewColumn = .sidebar
    @Environment(\.scenePhase) private var scenePhase

    private var fingerprint: String { settings.hosts.map { settings.apiFingerprint($0.id) }.joined(separator: "\n") }

    var body: some View {
        Group {
            if settings.hosts.isEmpty {
                NavigationStack { WelcomeView(settings: settings) }
            } else {
                NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: $preferredColumn) {
                    SessionSidebar(settings: settings, inbox: inbox, selection: $selection,
                        newSession: { compose(nil) }, openSettings: { showSettings = true },
                        resumeDraft: { compose($0) })
                        .navigationSplitViewColumnWidth(300)
                } detail: {
                    NavigationStack {
                        if let composing {
                            NewConversationView(settings: settings, seed: composing.seed) { ref in
                                self.composing = nil
                                selection = ref
                            }
                            .id(composing.id)
                        } else if let ref = selection, let api = settings.api(for: ref.hostId) {
                            SessionView(api: api, sessionId: ref.sessionId, hostId: ref.hostId,
                                        hostName: settings.host(ref.hostId)?.name, hostCount: settings.hosts.count,
                                        cockpitBaseURL: settings.host(ref.hostId)?.baseURL, cache: settings.snapshotCache(for: ref.hostId),
                                        onRead: { answer in inbox.applyRead(ref, answer: answer) })
                                .id("\(settings.apiFingerprint(ref.hostId)):\(ref.sessionId)")
                                .environment(\.columnVisibility, $columnVisibility)
                                .toolbar {
                                    if columnVisibility == .detailOnly {
                                        ToolbarItem(placement: .topBarLeading) {
                                            Button("Show sidebar", systemImage: "sidebar.leading") {
                                                withAnimation { columnVisibility = .all }
                                            }
                                            .keyboardShortcut("0", modifiers: [.command, .option])
                                        }
                                    }
                                }
                        } else {
                            ContentUnavailableView {
                                Label("Your work, within reach", systemImage: "text.bubble")
                            } description: {
                                Text("Choose a session from the sidebar, or start a conversation.")
                            } actions: {
                                Button("New conversation") { compose(nil) }.buttonStyle(.borderedProminent)
                            }
                        }
                    }
                }
                .navigationSplitViewStyle(.balanced)
            }
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                SettingsView(settings: settings)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showSettings = false } } }
            }
        }
        .onChange(of: selection) { _, next in
            if next != nil { composing = nil; preferredColumn = .detail }
        }
        .onOpenURL { url in
            guard let ref = ScopedSessionID(url: url), settings.host(ref.hostId) != nil else { return }
            selection = ref; preferredColumn = .detail
        }
        .onChange(of: MobileNotifications.shared.destination) { _, ref in
            guard let ref, settings.host(ref.hostId) != nil else { return }
            showSettings = false; composing = nil
            selection = ref; preferredColumn = .detail
            MobileNotifications.shared.destination = nil
        }
        .onChange(of: settings.book.membershipFingerprint) {
            if let selection, settings.host(selection.hostId) == nil { self.selection = nil }
        }
        .task(id: fingerprint) {
            inbox.sync(hosts: settings.hosts, settings: settings, active: scenePhase == .active)
            MobileNotifications.shared.settings = settings
            await MobileNotifications.shared.syncRegistrations()
        }
        .onChange(of: inbox.onCards) { _, sessions in
            if scenePhase == .active { MobileNotifications.shared.startAutomaticCards(sessions, projectName: inbox.projectName) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                inbox.start()
                MobileNotifications.shared.startAutomaticCards(inbox.onCards, projectName: inbox.projectName)
                Task { await MobileNotifications.shared.syncRegistrations() }
                Task { await settings.refreshAddresses() }
            } else { inbox.stop() }
        }
        .task {
            if let link = UserDefaults.standard.string(forKey: "addHostLink"),
               let parsed = Pairing.parsePairingURL(link),
               let paired = try? await Pairing.exchange(base: parsed.base, token: parsed.token, deviceName: UIDevice.current.name) {
                settings.upsert(baseURLString: parsed.base.absoluteString, token: paired.deviceToken, addresses: paired.addresses ?? [])
                await MobileNotifications.shared.promptAfterPairing()
            }
            if let id = UserDefaults.standard.string(forKey: "openSession") {
                selection = ScopedSessionID.resolveLaunchArg(sessionId: id,
                    hostHint: UserDefaults.standard.string(forKey: "openSessionHost"), hosts: settings.hosts)
                if selection != nil { preferredColumn = .detail }
            }
            if UserDefaults.standard.bool(forKey: "newSession") { compose(nil) }
            if let pending = MobileNotifications.shared.destination, settings.host(pending.hostId) != nil {
                selection = pending; preferredColumn = .detail
                MobileNotifications.shared.destination = nil
            }
            await settings.refreshAddresses()
        }
    }

    private func compose(_ seed: MobileDraft?) {
        selection = nil
        composing = Composing(seed: seed)
        preferredColumn = .detail
    }
}

private struct Composing: Identifiable {
    let id = UUID()
    let seed: MobileDraft?
}

extension ScopedSessionID {
    static func resolveLaunchArg(sessionId: String, hostHint: String?, hosts: [Host]) -> ScopedSessionID? {
        let host: Host?
        if let hint = hostHint?.lowercased(), !hint.isEmpty {
            host = hosts.first { $0.name.lowercased() == hint }
                ?? hosts.first { $0.baseURL?.host()?.lowercased() == hint }
        } else {
            host = hosts.first
        }
        guard let host else { return nil }
        return ScopedSessionID(hostId: host.id, sessionId: sessionId)
    }
}
