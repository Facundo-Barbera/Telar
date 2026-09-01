import SwiftUI

/// The cockpit's paired-device panel, from the phone: every device that may
/// reach the Mac, with rename, role, and revocation. "This iPhone" is badged
/// via callerDeviceId — the server names the caller from its credential, so
/// the app never stores its own device id. A view-only phone sees the list
/// read-only; management is a write like any other.
struct DevicesView: View {
    let api: EngineAPI
    @State private var status: RemoteStatus?
    @State private var error: String?
    @State private var renaming: RemoteDevice?
    @State private var renameDraft = ""
    @State private var confirmRevokeAll = false

    private var canManage: Bool { status?.callerRole != "observer" }

    var body: some View {
        Form {
            if let status {
                if !status.requireAuth {
                    Section {
                        Label {
                            Text("Pairing is off on the Mac — anything that can reach the cockpit has full control. These credentials matter again when it's turned on.")
                        } icon: {
                            Image(systemName: "lock.open").foregroundStyle(Theme.statusAmber)
                        }
                        .font(Theme.meta)
                    }
                }
                if status.callerRole == "observer" {
                    Section {
                        Label {
                            Text("This phone is view-only — it can see the devices but not change them.")
                        } icon: {
                            Image(systemName: "eye").foregroundStyle(Theme.statusAmber)
                        }
                        .font(Theme.meta)
                    }
                }

                let mine = status.devices.filter { $0.id == status.callerDeviceId }
                let others = status.devices.filter { $0.id != status.callerDeviceId }

                if !mine.isEmpty {
                    Section("This device") {
                        ForEach(mine) { device in
                            deviceRow(device, isSelf: true)
                        }
                    }
                }
                Section(others.isEmpty ? "" : "Other devices") {
                    if others.isEmpty {
                        Text(mine.isEmpty ? "No devices are paired." : "No other devices are paired.")
                            .font(Theme.meta)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(others) { device in
                        deviceRow(device, isSelf: false)
                    }
                }

                if canManage, !others.isEmpty, status.callerDeviceId != nil {
                    Section {
                        Button("Revoke all other devices", role: .destructive) {
                            confirmRevokeAll = true
                        }
                    } footer: {
                        Text("The lost-phone button: everything except this phone is logged out on its next request.")
                    }
                }
            } else if let error {
                Label(error, systemImage: "xmark.circle")
                    .foregroundStyle(Theme.statusRed)
                    .font(Theme.meta)
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Devices")
        .task { await load() }
        .refreshable { await load() }
        .alert("Rename device", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $renameDraft)
            Button("Rename") {
                if let device = renaming {
                    Task { await run { _ = try await api.renameDevice(device.id, name: renameDraft) } }
                }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .confirmationDialog("Revoke all other devices?", isPresented: $confirmRevokeAll, titleVisibility: .visible) {
            Button("Revoke them", role: .destructive) {
                Task { await run { _ = try await api.revokeOtherDevices() } }
            }
        } message: {
            Text("Every device except this one is logged out. They can pair again with a fresh code.")
        }
    }

    @ViewBuilder
    private func deviceRow(_ device: RemoteDevice, isSelf: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: platformSymbol(device.platform))
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(device.name)
                    if isSelf {
                        Text("This iPhone")
                            .font(Theme.metaSmall)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(.quaternary))
                    }
                }
                Text(subtitle(device))
                    .font(Theme.metaSmall)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if canManage {
                Menu {
                    Button {
                        Task { await run { _ = try await api.setDeviceRole(device.id, role: "full") } }
                    } label: {
                        Label("Full access", systemImage: device.role == "full" ? "checkmark" : "hand.raised")
                    }
                    Button {
                        Task { await run { _ = try await api.setDeviceRole(device.id, role: "observer") } }
                    } label: {
                        Label("View only", systemImage: device.role == "observer" ? "checkmark" : "eye")
                    }
                    Divider()
                    Button {
                        renameDraft = device.name
                        renaming = device
                    } label: {
                        Label("Rename…", systemImage: "pencil")
                    }
                } label: {
                    Text(device.role == "observer" ? "View only" : "Full")
                        .font(Theme.metaSmall)
                        .foregroundStyle(device.role == "observer" ? Theme.statusAmber : .secondary)
                }
            } else {
                Text(device.role == "observer" ? "View only" : "Full")
                    .font(Theme.metaSmall)
                    .foregroundStyle(.secondary)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if canManage && !isSelf {
                Button("Revoke", role: .destructive) {
                    Task { await run { try await api.revokeDevice(device.id) } }
                }
            }
        }
    }

    private func subtitle(_ device: RemoteDevice) -> String {
        if let seen = device.lastSeenAt {
            return "Last seen \(ago(seen))"
        }
        if let created = device.createdAt {
            return "Paired \(ago(created))"
        }
        return "Paired"
    }

    private func ago(_ ms: Timestamp) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        return date.formatted(.relative(presentation: .named))
    }

    private func platformSymbol(_ platform: String?) -> String {
        switch platform {
        case "ios": "iphone"
        case "browser": "desktopcomputer"
        default: "questionmark.circle"
        }
    }

    private func run(_ operation: () async throws -> Void) async {
        do {
            try await operation()
            error = nil
        } catch let apiError as EngineAPIError {
            // A 409 on the last full device arrives as its typed message.
            error = apiError.errorDescription
        } catch {
            self.error = error.localizedDescription
        }
        await load()
    }

    private func load() async {
        do {
            status = try await api.remoteStatus()
        } catch let apiError as EngineAPIError {
            error = apiError.errorDescription
        } catch {
            self.error = error.localizedDescription
        }
    }
}
