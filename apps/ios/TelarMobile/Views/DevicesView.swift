import SwiftUI

/// The cockpit's paired-device panel, from the phone: every device that may
/// reach the Mac, with rename, role, and revocation. "This iPhone" is badged
/// via callerDeviceId — the server names the caller from its credential, so
/// the app never stores its own device id. A view-only phone sees the list
/// read-only; management is a write like any other.
///
/// SettingsKit cards, not a Form: each device is a row with a platform
/// glyph, a role chip that opens the management menu, and the lost-phone
/// button under its own card.
struct DevicesView: View {
    let api: EngineAPI
    @State private var status: RemoteStatus?
    @State private var error: String?
    @State private var renaming: RemoteDevice?
    @State private var renameDraft = ""
    @State private var confirmRevokeAll = false
    @State private var confirmRevoke: RemoteDevice?

    private var canManage: Bool { status?.callerRole != "observer" }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                if let status {
                    if !status.requireAuth {
                        SettingsCard {
                            StatusBanner(
                                icon: "lock.open", color: Theme.statusAmber,
                                title: "Pairing is off on the Mac.",
                                detail: "Anything that can reach the cockpit has full control. These credentials matter again when it's turned on."
                            )
                        }
                    }
                    if status.callerRole == "observer" {
                        SettingsCard {
                            StatusBanner(
                                icon: "eye", color: Theme.statusAmber,
                                title: "This phone is view-only.",
                                detail: "It can see the devices but not change them."
                            )
                        }
                    }

                    let mine = status.devices.filter { $0.id == status.callerDeviceId }
                    let others = status.devices.filter { $0.id != status.callerDeviceId }

                    if !mine.isEmpty {
                        VStack(spacing: 0) {
                            SettingsSectionLabel("This device")
                            SettingsCard {
                                ForEach(Array(mine.enumerated()), id: \.element.id) { index, device in
                                    if index > 0 { CardDivider() }
                                    deviceRow(device, isSelf: true)
                                }
                            }
                        }
                    }

                    VStack(spacing: 0) {
                        SettingsSectionLabel(mine.isEmpty ? "Devices" : "Other devices")
                        SettingsCard {
                            if others.isEmpty {
                                StatusBanner(
                                    icon: "antenna.radiowaves.left.and.right", color: Theme.textMuted,
                                    title: mine.isEmpty ? "No devices are paired." : "No other devices are paired.",
                                    detail: "Devices appear here as they pair from the Mac's Remote access panel."
                                )
                            }
                            ForEach(Array(others.enumerated()), id: \.element.id) { index, device in
                                if index > 0 { CardDivider() }
                                deviceRow(device, isSelf: false)
                            }
                        }
                        if canManage {
                            SettingsFootnote("Tap the role chip to rename, change access, or revoke. Revoking logs the device out on its next request.")
                        }
                    }

                    if canManage, !others.isEmpty, status.callerDeviceId != nil {
                        VStack(spacing: 0) {
                            SettingsCard {
                                Button {
                                    confirmRevokeAll = true
                                } label: {
                                    CardRow(
                                        icon: "person.crop.circle.badge.xmark", iconColor: Theme.statusRed,
                                        title: "Revoke all other devices", titleColor: Theme.statusRed
                                    ) { EmptyView() }
                                }
                                .buttonStyle(.plain)
                            }
                            SettingsFootnote("The lost-phone button: everything except this phone is logged out on its next request.")
                        }
                    }
                } else if let error {
                    SettingsCard {
                        StatusBanner(icon: "xmark.circle", color: Theme.statusRed, title: error)
                    }
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.top, 48)
                }

                if status != nil, let error {
                    SettingsCard {
                        StatusBanner(icon: "exclamationmark.triangle", color: Theme.statusAmber, title: error)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .background(Theme.sheet)
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
        .confirmationDialog(
            "Revoke \(confirmRevoke?.name ?? "device")?",
            isPresented: Binding(get: { confirmRevoke != nil }, set: { if !$0 { confirmRevoke = nil } }),
            titleVisibility: .visible
        ) {
            Button("Revoke", role: .destructive) {
                if let device = confirmRevoke {
                    Task { await run { try await api.revokeDevice(device.id) } }
                }
                confirmRevoke = nil
            }
        } message: {
            Text("It is logged out on its next request and can pair again with a fresh code.")
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
            // ABSOLUTE ON PURPOSE: a 27pt square, fixed in both dimensions and
            // clipping, so a glyph that grew with the reader's text would only
            // outgrow its own box. Wants a @ScaledMetric frame — a layout
            // change rather than a token swap (#674).
            Image(systemName: platformSymbol(device.platform))
                .font(.system(size: 17))
                .foregroundStyle(Theme.textMuted)
                .frame(width: 27, height: 27)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(device.name)
                        .font(.system(.callout, weight: .semibold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                    if isSelf {
                        Text("This iPhone")
                            .font(.system(Theme.caption, weight: .medium))
                            .foregroundStyle(Theme.accent)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(Theme.accent.opacity(0.12)))
                    }
                }
                Text(subtitle(device))
                    .font(.system(Theme.footnote))
                    .foregroundStyle(Theme.textMuted)
                    .tabularNumbers()
            }
            Spacer(minLength: 8)
            if canManage {
                Menu {
                    Section("Access") {
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
                    }
                    Button {
                        renameDraft = device.name
                        renaming = device
                    } label: {
                        Label("Rename…", systemImage: "pencil")
                    }
                    if !isSelf {
                        Button(role: .destructive) {
                            confirmRevoke = device
                        } label: {
                            Label("Revoke", systemImage: "xmark.circle")
                        }
                    }
                } label: {
                    roleChip(device.role)
                }
            } else {
                roleChip(device.role)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    /// The role as a chip — the same capsule idiom as the composer's pills.
    private func roleChip(_ role: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: role == "observer" ? "eye" : "checkmark.shield")
                .font(.system(Theme.caption, weight: .medium))
            Text(role == "observer" ? "View only" : "Full")
                .font(.system(Theme.footnote, weight: .semibold))
            if canManage {
                Image(systemName: "chevron.down").font(.system(Theme.captionTiny, weight: .medium))
            }
        }
        .foregroundStyle(role == "observer" ? Theme.statusAmber : Theme.text)
        .padding(.horizontal, 12)
        .frame(height: 32)
        .background(Theme.subtle)
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
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
