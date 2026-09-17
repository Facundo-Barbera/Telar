import SwiftUI

/// The gear sheet: every paired Mac, each a door to its own settings, plus
/// "Add a Mac…". ConnectView keeps owning the pairing flow; this is just
/// the hallway, wearing the same card clothes as the rest of the app.
struct SettingsView: View {
    let settings: AppSettings
    @State private var pushTarget: PushTarget?
    /// `-openDevices 1` launch arg — automation affordance like -openSession.
    @State private var openDevicesSeed = UserDefaults.standard.bool(forKey: "openDevices")

    enum PushTarget: Hashable {
        case host(HostID)
        case addMac
        case devices(HostID)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                NavigationLink { NotificationSettingsView() } label: {
                    Label("Notifications & activities", systemImage: "bell.badge")
                        .frame(maxWidth: .infinity, alignment: .leading).padding()
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.radiusCard))
                }

                VStack(spacing: 0) {
                    SettingsSectionLabel("Cockpits")
                    SettingsCard {
                        ForEach(Array(settings.hosts.enumerated()), id: \.element.id) { index, host in
                            if index > 0 { CardDivider() }
                            CardNavRow(
                                icon: "desktopcomputer",
                                title: host.name,
                                subtitle: (host.baseURL?.host() ?? host.baseURLString)
                                    + (settings.token(for: host.id) != nil ? " · paired" : " · open")
                            ) { pushTarget = .host(host.id) }
                        }
                        if !settings.hosts.isEmpty { CardDivider() }
                        CardNavRow(icon: "plus.circle.fill", title: "Add a Mac…", subtitle: "Scan a pairing code or connect by address") {
                            pushTarget = .addMac
                        }
                    }
                    SettingsFootnote("Every Mac pairs with its own key. Sessions from all of them share the inbox; the desktop icon in the top bar filters.")
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .background(Theme.sheet)
        .navigationTitle("Settings")
        .navigationDestination(item: $pushTarget) { target in
            switch target {
            case .host(let id):
                HostSettingsView(settings: settings, hostId: id)
            case .addMac:
                ConnectView(settings: settings, target: .new)
            case .devices(let id):
                if let api = settings.api(for: id) {
                    DevicesView(api: api)
                }
            }
        }
        .task {
            if openDevicesSeed, let first = settings.hosts.first {
                openDevicesSeed = false
                pushTarget = .devices(first.id)
            }
        }
    }
}

/// One Mac's own panel: rename, connection, its device list, removal.
struct HostSettingsView: View {
    let settings: AppSettings
    let hostId: HostID
    @State private var nameDraft = ""
    @State private var confirmRemove = false
    @Environment(\.dismiss) private var dismiss

    private var host: Host? { settings.host(hostId) }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 0) {
                    SettingsSectionLabel("Name")
                    SettingsCard {
                        CardField(label: "Shown on inbox rows and menus", placeholder: host?.baseURL?.host() ?? "My Mac", text: $nameDraft)
                    }
                }

                VStack(spacing: 0) {
                    SettingsSectionLabel("This Mac")
                    SettingsCard {
                        CardNavRow(
                            icon: "server.rack",
                            title: "Connection",
                            subtitle: host?.baseURL?.host() ?? host?.baseURLString
                        ) { pushConnect = true }
                        if settings.api(for: hostId) != nil {
                            CardDivider()
                            /**
                             THE AGENT'S OWN SCREEN (#556), beside Devices and
                             for the same reason: both are panels on the MAC,
                             reached with this phone's paired credential, rather
                             than settings of this app. The Agent screen's off
                             state used to send the reader to find a desktop;
                             this is the door that makes that unnecessary.

                             GATED ON A CREDENTIAL, like Devices: an unpaired
                             Mac cannot be read or written, so the row would open
                             onto a screen that could only report a refusal.
                             */
                            CardNavRow(
                                icon: "sparkles",
                                title: "Agent",
                                subtitle: "Its switch, key, model and defaults"
                            ) { pushAgent = true }
                            CardDivider()
                            CardNavRow(
                                icon: "iphone.radiowaves.left.and.right",
                                title: "Devices",
                                subtitle: "Who may reach this Mac"
                            ) { pushDevices = true }
                        }
                    }
                }

                VStack(spacing: 0) {
                    SettingsCard {
                        Button {
                            confirmRemove = true
                        } label: {
                            CardRow(icon: "trash", iconColor: Theme.statusRed, title: "Remove this Mac", titleColor: Theme.statusRed) { EmptyView() }
                        }
                        .buttonStyle(.plain)
                    }
                    SettingsFootnote("Removes the pairing credential and drafts from this phone. The Mac keeps running; revoke this phone from its Remote access panel to kill the credential everywhere.")
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .background(Theme.sheet)
        .navigationTitle(host?.name ?? "Mac")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: $pushConnect) {
            ConnectView(settings: settings, target: .existing(hostId))
        }
        .navigationDestination(isPresented: $pushAgent) {
            if let api = settings.api(for: hostId) {
                AgentSettingsView(api: api)
            }
        }
        .navigationDestination(isPresented: $pushDevices) {
            if let api = settings.api(for: hostId) {
                DevicesView(api: api)
            }
        }
        .onAppear { nameDraft = host?.name ?? "" }
        .onChange(of: nameDraft) {
            guard host != nil else { return }
            settings.rename(hostId, to: nameDraft)
        }
        .confirmationDialog("Remove \(host?.name ?? "this Mac")?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                settings.remove(hostId)
                dismiss()
            }
        } message: {
            Text("This phone forgets the credential and any pending drafts for it. Pair again anytime.")
        }
    }

    @State private var pushConnect = false
    @State private var pushAgent = false
    @State private var pushDevices = false
}
