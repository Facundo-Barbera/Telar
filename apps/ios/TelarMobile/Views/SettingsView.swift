import SwiftUI

/// The gear sheet: connection (host + pairing) and the cockpit's device
/// panel. ConnectView keeps owning the pairing flow; this is just the
/// hallway, wearing the same card clothes as the rest of the app.
struct SettingsView: View {
    let settings: AppSettings
    @State private var pushConnect = false
    /// `-openDevices 1` launch arg — automation affordance like -openSession.
    @State private var pushDevices = UserDefaults.standard.bool(forKey: "openDevices")

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 0) {
                    SettingsSectionLabel("Cockpit")
                    SettingsCard {
                        CardNavRow(
                            icon: "server.rack",
                            title: "Connection",
                            subtitle: settings.baseURL?.host() ?? "Not configured"
                        ) { pushConnect = true }
                        if settings.api != nil {
                            CardDivider()
                            CardNavRow(
                                icon: "iphone.radiowaves.left.and.right",
                                title: "Devices",
                                subtitle: "Who may reach the Mac"
                            ) { pushDevices = true }
                        }
                    }
                    SettingsFootnote(settings.deviceToken != nil
                        ? "Paired — this phone holds a device credential for the cockpit."
                        : "Not paired. An open cockpit needs no credential; a gated one hands out pairing codes under Remote access.")
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .background(Theme.sheet)
        .navigationTitle("Settings")
        .navigationDestination(isPresented: $pushConnect) {
            ConnectView(settings: settings)
        }
        .navigationDestination(isPresented: $pushDevices) {
            if let api = settings.api {
                DevicesView(api: api)
            }
        }
    }
}
