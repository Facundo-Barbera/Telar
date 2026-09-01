import SwiftUI

/// The gear sheet: connection (host + pairing) and the cockpit's device
/// panel. ConnectView keeps owning the pairing flow; this is just the hallway.
struct SettingsView: View {
    let settings: AppSettings

    var body: some View {
        Form {
            Section {
                NavigationLink {
                    ConnectView(settings: settings)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Connection")
                        Text(settings.baseURL?.host() ?? "Not configured")
                            .font(Theme.metaSmall)
                            .foregroundStyle(.secondary)
                    }
                }
                if let api = settings.api {
                    NavigationLink {
                        DevicesView(api: api)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Devices")
                            Text("Who may reach the Mac")
                                .font(Theme.metaSmall)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle("Settings")
    }
}
