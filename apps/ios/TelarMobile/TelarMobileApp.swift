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
    @State private var resumedDraft: MobileDraft?
    @State private var selection: ScopedSessionID?
    @State private var showSettings = UserDefaults.standard.bool(forKey: "openSettings")
    @State private var showNewSession = UserDefaults.standard.bool(forKey: "newSession")
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
                        newSession: { resumedDraft = nil; showNewSession = true }, openSettings: { showSettings = true },
                        resumeDraft: { resumedDraft = $0; showNewSession = true })
                        .navigationSplitViewColumnWidth(min: 260, ideal: 300, max: 380)
                } detail: {
                    NavigationStack {
                        if let ref = selection, let api = settings.api(for: ref.hostId) {
                            SessionView(api: api, sessionId: ref.sessionId, hostId: ref.hostId, cockpitBaseURL: settings.host(ref.hostId)?.baseURL, cache: settings.snapshotCache(for: ref.hostId))
                                .id("\(settings.apiFingerprint(ref.hostId)):\(ref.sessionId)")
                                // THE WAY BACK. The split view's own toggle is a
                                // system placement the detail's toolbar can
                                // displace, and once it did there was no control
                                // left that could show the sidebar again. This
                                // one appears only while the sidebar is hidden.
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
                                Button("New conversation") { showNewSession = true }.buttonStyle(.borderedProminent)
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
        .sheet(isPresented: $showNewSession) {
            NavigationStack {
                NewSessionView(settings: settings, draft: resumedDraft) { ref in
                    showNewSession = false
                    selection = ref
                    preferredColumn = .detail
                }
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { showNewSession = false } } }
            }.interactiveDismissDisabled(false)
        }
        .onChange(of: selection) { _, next in
            if next != nil { preferredColumn = .detail }
        }
        .onOpenURL { url in
            guard let ref = ScopedSessionID(url: url), settings.host(ref.hostId) != nil else { return }
            selection = ref; preferredColumn = .detail
        }
        .onChange(of: MobileNotifications.shared.destination) { _, ref in
            guard let ref, settings.host(ref.hostId) != nil else { return }
            showSettings = false; showNewSession = false
            selection = ref; preferredColumn = .detail
            MobileNotifications.shared.destination = nil
        }
        .onChange(of: settings.book.membershipFingerprint) {
            if let selection, settings.host(selection.hostId) == nil { self.selection = nil }
        }
        .task(id: fingerprint) {
            inbox.sync(hosts: settings.hosts, settings: settings)
            MobileNotifications.shared.settings = settings
            await MobileNotifications.shared.syncRegistrations()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                inbox.start()
                Task { await MobileNotifications.shared.syncRegistrations() }
            } else { inbox.stop() }
        }
        .task {
            if let link = UserDefaults.standard.string(forKey: "addHostLink"),
               let parsed = Pairing.parsePairingURL(link),
               let token = try? await Pairing.exchange(base: parsed.base, token: parsed.token, deviceName: UIDevice.current.name) {
                settings.upsert(baseURLString: parsed.base.absoluteString, token: token)
            }
            if let id = UserDefaults.standard.string(forKey: "openSession") {
                selection = ScopedSessionID.resolveLaunchArg(sessionId: id,
                    hostHint: UserDefaults.standard.string(forKey: "openSessionHost"), hosts: settings.hosts)
                if selection != nil { preferredColumn = .detail }
            }
            if let pending = MobileNotifications.shared.destination, settings.host(pending.hostId) != nil {
                selection = pending; preferredColumn = .detail
                MobileNotifications.shared.destination = nil
            }
        }
    }
}

extension ScopedSessionID {
    /// Launch-arg resolution, pure for tests: no hint = first host (the
    /// single-host behavior); a hint matches the host's name, then its URL
    /// host, case-insensitively.
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
