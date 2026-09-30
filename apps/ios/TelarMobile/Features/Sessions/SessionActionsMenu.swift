import SwiftUI

struct SessionActionsMenu: View {
    let store: SessionStore
    let ref: ScopedSessionID?
    let hostName: String?
    let projectName: String?
    let cockpitBaseURL: URL?
    let spoken: SpokenSession
    let lastReply: String?
    let onRename: () -> Void

    var body: some View {
        Menu {
            if let session = store.sync.session {
                Section {
                    Text(session.title)
                    Text(SessionActionsMenu.detail(project: projectName, host: hostName, workspace: session.workspace))
                }
            }
            Section {
                Button("Rename", systemImage: "pencil", action: onRename)
                if let ref, store.sync.session != nil {
                    Button(MobileNotifications.shared.isMuted(ref) ? "Unmute notifications" : "Mute notifications", systemImage: "bell.slash") {
                        Task { await MobileNotifications.shared.toggleMute(ref) }
                    }
                }
            }
            Section {
                if ref != nil, let session = store.sync.session, let base = cockpitBaseURL {
                    ShareLink(item: session.cockpitURL(base: base)) { Label("Open on Mac", systemImage: "desktopcomputer") }
                }
                if Talkback.shared.isSpeaking(spoken) {
                    Button("Stop speaking", systemImage: "speaker.slash") { Talkback.shared.stop() }
                } else if let lastReply {
                    Button("Speak the last reply", systemImage: "speaker.wave.2") {
                        Talkback.shared.speak(speakableText(lastReply), for: spoken)
                    }
                }
            }
            Section {
                if store.sync.session?.settledOverride == "settled" {
                    Button("Unarchive", systemImage: "arrow.uturn.backward") { Task { await store.setSettled(false) } }
                } else {
                    Button("Archive", systemImage: "archivebox") { Task { await store.setSettled(true) } }
                }
            }
            if let usage = store.sync.session?.usage {
                Section { Text(SessionActionsMenu.usageLine(usage)) }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .foregroundStyle(Theme.textMuted)
        }
        .accessibilityLabel("Session actions")
    }

    static func detail(project: String?, host: String?, workspace: SessionWorkspace) -> String {
        let place = workspace.mode == "worktree" ? "Worktree" : "Checkout"
        let branch = workspace.branch.map { "\(place) · \($0)" } ?? place
        let parts = [project, host, branch].compactMap { $0?.isEmpty == false ? $0 : nil }
        return parts.joined(separator: " · ")
    }

    static func usageLine(_ usage: UsageSnapshot) -> String {
        let total = usage.tokens.input + usage.tokens.output + usage.tokens.cacheRead + usage.tokens.cacheCreate
        let tokens = total >= 1_000_000
            ? String(format: "%.1fM tokens", Double(total) / 1_000_000)
            : "\(total / 1000)k tokens"
        if let cost = usage.costUsd {
            return tokens + String(format: " · $%.2f", cost)
        }
        return tokens
    }
}
