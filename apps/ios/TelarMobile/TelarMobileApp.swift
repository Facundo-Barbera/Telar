import SwiftUI

@main
struct TelarMobileApp: App {
    @State private var settings = AppSettings()

    var body: some Scene {
        WindowGroup {
            RootView(settings: settings)
        }
    }
}

struct RootView: View {
    let settings: AppSettings
    /// `-openSettings 1` launch arg — automation affordance like -openSession.
    @State private var showSettings = UserDefaults.standard.bool(forKey: "openSettings")
    // `-newSession 1` launch arg — automation affordance like -openSession.
    @State private var showNewSession = UserDefaults.standard.bool(forKey: "newSession")
    /// Navigation is HOST-SCOPED: a session id means nothing without the Mac
    /// that minted it. `-openSession <id>` resolves against the first host
    /// (identical to the single-host world); `-openSessionHost <name-or-host>`
    /// disambiguates in two-stack automation.
    @State private var path: [ScopedSessionID] = []

    var body: some View {
        NavigationStack(path: $path) {
            if !settings.hosts.isEmpty {
                InboxView(settings: settings)
                    .navigationTitle("Telar")
                    .navigationDestination(for: ScopedSessionID.self) { ref in
                        if let hostApi = settings.api(for: ref.hostId) {
                            SessionView(api: hostApi, sessionId: ref.sessionId, hostId: ref.hostId)
                                .id(settings.apiFingerprint(ref.hostId))
                        } else {
                            ContentUnavailableView(
                                "That Mac was removed",
                                systemImage: "desktopcomputer.trianglebadge.exclamationmark"
                            )
                        }
                    }
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button {
                                showNewSession = true
                            } label: {
                                Image(systemName: "plus")
                            }
                            .accessibilityLabel("New session")
                        }
                        ToolbarItem(placement: .topBarTrailing) {
                            Button {
                                showSettings = true
                            } label: {
                                Image(systemName: "gearshape")
                            }
                        }
                    }
                    .sheet(isPresented: $showNewSession) {
                        NavigationStack {
                            NewSessionView(settings: settings) { ref in
                                showNewSession = false
                                // Pushing while the sheet's dismissal is still
                                // animating gets the push dropped on device —
                                // land in the inbox instead of the session.
                                // Let the dismissal finish first.
                                Task {
                                    try? await Task.sleep(for: .milliseconds(600))
                                    path.append(ref)
                                }
                            }
                        }
                    }
                    .sheet(isPresented: $showSettings) {
                        NavigationStack {
                            SettingsView(settings: settings)
                                .toolbar {
                                    ToolbarItem(placement: .confirmationAction) {
                                        Button("Done") { showSettings = false }
                                    }
                                }
                        }
                    }
            } else {
                // The front door welcomes; ConnectView is where it guides you.
                WelcomeView(settings: settings)
            }
        }
        // A removed Mac's pushes must not survive it — prune, don't trap.
        .onChange(of: settings.book.membershipFingerprint) {
            let living = Set(settings.hosts.map(\.id))
            path.removeAll { !living.contains($0.hostId) }
        }
        .task {
            // `simctl launch … -openSession <id> [-openSessionHost <hint>]`.
            guard path.isEmpty, let sessionId = UserDefaults.standard.string(forKey: "openSession") else { return }
            let hint = UserDefaults.standard.string(forKey: "openSessionHost")
            if let ref = ScopedSessionID.resolveLaunchArg(sessionId: sessionId, hostHint: hint, hosts: settings.hosts) {
                path = [ref]
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
