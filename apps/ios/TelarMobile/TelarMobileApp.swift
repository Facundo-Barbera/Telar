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
    // `simctl launch booted com.telar.mobile -openSession <id>` — launch
    // arguments land in UserDefaults, which is what makes the session view
    // reachable from automation. Inert in normal use.
    @State private var path: [EngineID] =
        UserDefaults.standard.string(forKey: "openSession").map { [$0] } ?? []

    var body: some View {
        NavigationStack(path: $path) {
            if let api = settings.api {
                InboxView(api: api)
                    // Rebuild the whole surface when the cockpit or the
                    // pairing credential changes.
                    .id(settings.baseURLString + (settings.deviceToken ?? ""))
                    .navigationTitle("Telar")
                    .navigationDestination(for: EngineID.self) { sessionId in
                        SessionView(api: api, sessionId: sessionId)
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
                            NewSessionView(api: api) { sessionId in
                                showNewSession = false
                                // Pushing while the sheet's dismissal is still
                                // animating gets the push dropped on device —
                                // land in the inbox instead of the session.
                                // Let the dismissal finish first.
                                Task {
                                    try? await Task.sleep(for: .milliseconds(600))
                                    path.append(sessionId)
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
                ConnectView(settings: settings)
            }
        }
    }
}
