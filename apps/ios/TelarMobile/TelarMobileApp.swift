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
    @State private var showSettings = false
    @State private var showNewSession = false
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
                                path.append(sessionId)
                            }
                        }
                    }
                    .sheet(isPresented: $showSettings) {
                        NavigationStack {
                            ConnectView(settings: settings)
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
