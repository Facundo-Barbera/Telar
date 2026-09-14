import SwiftUI

/// The inbox, wearing t3 mobile's thread-list anatomy: one flat list — an
/// active block of edge-to-edge three-line rows (no card fill; color and
/// hierarchy carry state), then a "Settled" divider and a receded slim tail.
/// Activity never reorders the active block. A List so rows get swipe
/// actions: full-swipe always commits the lifecycle verb, never delete.
struct InboxView: View {
    let settings: AppSettings
    /// One store per Mac, merged; a host filter narrows without stopping
    /// the other Macs' polls.
    @State private var inbox = MergedInbox()
    /// t3's pagination: 10 settled built initially, +25 per "Show more".
    @State private var settledLimit = 10
    @Environment(\.scenePhase) private var scenePhase

    private var multiHost: Bool { settings.hosts.count > 1 }

    /// Changes when any host's address/credential/membership changes — the
    /// store-reconcile trigger.
    private var fleetFingerprint: String {
        settings.hosts.map { settings.apiFingerprint($0.id) }.joined(separator: "\n")
    }

    var body: some View {
        List {
            // One quiet row per unreachable Mac; the healthy ones keep
            // rendering underneath. Unauthorized escalates to red and taps
            // through — a retry can't fix a credential.
            ForEach(inbox.failures) { failure in
                HStack(spacing: 6) {
                    Image(systemName: failure.needsPairing ? "lock.circle" : "wifi.exclamationmark")
                        .font(.system(size: 11))
                    // With a copy on the phone the rows stay and this line
                    // says how old they are; without one it says what went
                    // wrong, because the failure is all there is to show.
                    Text(failureLine(failure))
                        .font(.system(size: 13))
                }
                .foregroundStyle(failure.needsPairing ? Theme.statusRed : Theme.statusAmber)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
            }

            ForEach(inbox.sections.active) { hosted in
                ThreadCardRow(
                    session: hosted.session,
                    projectName: inbox.projectName(hosted),
                    hostLabel: multiHost ? hostName(hosted.hostId) : nil
                )
                    // The phone's own copy of a Mac that is away: still a
                    // row, still tappable, visibly not the Mac's answer.
                    .opacity(inbox.staleHosts.contains(hosted.hostId) ? 0.55 : 1)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparatorTint(Theme.borderSubtle)
                    .alignmentGuide(.listRowSeparatorLeading) { _ in 20 }
                    .overlay { NavigationLink(value: hosted.id) { EmptyView() }.opacity(0) }
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button {
                            Task { await inbox.setSettled(hosted.id, true) }
                        } label: {
                            Label("Settle", systemImage: "checkmark")
                        }
                        .tint(Theme.textMuted)
                    }
            }

            // THE SETTLED ROWS ARE NOT HERE UNTIL ASKED FOR (#457). The Mac
            // answers the unsettled list — 7 rows rather than 291 — and says
            // how many it kept; `shelvedOnMacs` is that count, and it is what
            // keeps this divider on screen so there is something to tap.
            // Snoozed rows are never withheld, so the tail is non-empty on its
            // own whenever any are sleeping.
            if !inbox.sections.tail.isEmpty || inbox.shelvedOnMacs > 0 {
                SettledDivider()
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets())
                ForEach(inbox.sections.tail.prefix(settledLimit)) { hosted in
                    SlimThreadRow(session: hosted.session, snoozed: inbox.sections.snoozed.contains { $0.id == hosted.id })
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets())
                        .overlay { NavigationLink(value: hosted.id) { EmptyView() }.opacity(0) }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button {
                                Task { await inbox.setSettled(hosted.id, false) }
                            } label: {
                                Label("Un-settle", systemImage: "arrow.uturn.backward")
                            }
                            .tint(Theme.textMuted)
                        }
                }
                /**
                 THE ROWS THE MAC KEPT, ASKED FOR ON A TAP (#457).

                 It sends the unsettled list and a count, so until this is
                 pressed there is nothing to page through — which is why this
                 sits above the "Show more" button rather than replacing it.
                 Once the rows arrive the Mac keeps sending them and this is
                 gone, and paging takes over as it always did.
                 */
                if inbox.shelvedOnMacs > 0 && inbox.sections.settled.isEmpty {
                    Button {
                        Task { await inbox.showSettled() }
                    } label: {
                        shelfButtonLabel("Show settled (\(inbox.shelvedOnMacs))")
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                } else if inbox.sections.tail.count > settledLimit {
                    Button {
                        settledLimit += 25
                    } label: {
                        shelfButtonLabel("Show more (\(inbox.sections.tail.count - settledLimit) settled hidden)")
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
            }

            if inbox.loaded && inbox.sections.isEmpty {
                ContentUnavailableView(
                    "No sessions",
                    systemImage: "tray",
                    description: Text("Sessions started on the Mac appear here.")
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .padding(.top, 60)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .toolbar {
            if multiHost {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Button {
                            inbox.filter = nil
                        } label: {
                            row("All Macs", selected: inbox.filter == nil)
                        }
                        ForEach(settings.hosts) { host in
                            Button {
                                inbox.filter = host.id
                            } label: {
                                row(host.name, selected: inbox.filter == host.id)
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "desktopcomputer")
                            if let filter = inbox.filter {
                                Text(hostName(filter)).font(.system(size: 13, weight: .medium))
                            }
                        }
                    }
                    .accessibilityLabel("Filter by Mac")
                }
            }
        }
        .refreshable { await inbox.refresh() }
        .task(id: fleetFingerprint) { inbox.sync(hosts: settings.hosts, settings: settings) }
        .onDisappear { inbox.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { inbox.start() } else { inbox.stop() }
        }
    }

    private func hostName(_ id: HostID) -> String {
        settings.host(id)?.name ?? "Mac"
    }

    /// The dashed pill under the settled tail. Extracted when a second button
    /// joined it (#457) so the two cannot drift apart visually.
    @ViewBuilder private func shelfButtonLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Theme.textMuted)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(Theme.border, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
            )
    }

    private func failureLine(_ failure: MergedInbox.Failure) -> String {
        let name = multiHost ? hostName(failure.hostId) : "The Mac"
        if let recordedAt = failure.recordedAt, !failure.needsPairing {
            return "\(name) — showing what was recorded at \(recordedAtLabel(recordedAt)), retrying"
        }
        return multiHost ? "\(name) — \(failure.message)" : failure.message
    }

    @ViewBuilder private func row(_ label: String, selected: Bool) -> some View {
        if selected {
            Label(label, systemImage: "checkmark")
        } else {
            Text(label)
        }
    }
}

/// "Settled" + a hairline filling the width — the list's only header.
struct SettledDivider: View {
    var body: some View {
        HStack(spacing: 10) {
            Text("Settled")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.textMuted)
            Rectangle().fill(Theme.border).frame(height: 1)
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 6)
    }
}

/// The active row: three lines, edge-to-edge, px-20 py-10. Status replaces
/// the timestamp when non-ready — only act-now / in-motion / broken get
/// color; ready shows the relative time in tertiary.
struct ThreadCardRow: View {
    let session: Session
    let projectName: String?
    /// Which Mac, when more than one is paired; nil renders nothing.
    var hostLabel: String?

    private var status: (label: String, color: Color)? {
        if session.lastTurnFailed == true && session.activity == .idle {
            return ("Failed", Theme.statusRed)
        }
        switch session.activity {
        case .blocked: return ("Approval", Theme.statusAmber)
        case .working: return ("Working", Theme.statusSky)
        case .queued: return ("Queued", Theme.statusSky)
        case .monitoring: return ("Monitoring", Theme.statusSky)
        case .idle: return nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                Text(projectName ?? "No project")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                if let hostLabel {
                    Text(hostLabel)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.textMuted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Theme.subtle))
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if let status {
                    HStack(spacing: 5) {
                        if session.activity == .working {
                            SteppedPulseDot(color: status.color)
                        }
                        Text(status.label)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(status.color)
                    }
                } else {
                    Text(relativeTime(session.activityAt ?? session.updatedAt))
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textMuted)
                        .tabularNumbers()
                }
            }
            Text(session.title)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Theme.text)
                .lineLimit(2)
            HStack(spacing: 8) {
                Text(session.workspace.branch ?? session.workspace.mode)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                Text("·").foregroundStyle(Theme.textMuted)
                Text(session.driver)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

/// The receded state: one line, min 44pt, favicon at 40%, regular-weight
/// muted title, mono tertiary timestamp, no hairline, no metadata.
struct SlimThreadRow: View {
    let session: Session
    let snoozed: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: snoozed ? "clock" : "folder")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textMuted)
                .opacity(0.4)
            Text(session.title)
                .font(.system(size: 16))
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(relativeTime(session.updatedAt))
                .font(.system(size: 14, design: .monospaced))
                .foregroundStyle(Theme.textMuted)
                .tabularNumbers()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

/// Row surface responds to interaction only — pressed state is the hover
/// fill. Used by request-card action buttons.
struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Theme.fill : .clear)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusRow))
            .animation(.easeInOut(duration: 0.15), value: configuration.isPressed)
    }
}

/// Kept for the session header, where only the dot fits.
struct ActivityBadge: View {
    let activity: SessionActivity

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .accessibilityLabel(String(describing: activity))
    }

    private var color: Color {
        switch activity {
        case .blocked: Theme.statusAmber
        case .working, .queued, .monitoring: Theme.statusSky
        case .idle: Theme.textMuted.opacity(0.4)
        }
    }
}

func relativeTime(_ timestamp: Timestamp) -> String {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .abbreviated
    return formatter.localizedString(for: timestamp.date, relativeTo: Date())
}
