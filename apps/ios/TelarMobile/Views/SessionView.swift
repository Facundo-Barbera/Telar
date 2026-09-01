import SwiftUI

struct SessionView: View {
    @State private var store: SessionStore
    @State private var draft = ""
    @State private var renaming = false
    @State private var renameDraft = ""
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss

    init(api: any EngineAPI, sessionId: EngineID) {
        _store = State(initialValue: SessionStore(api: api, sessionId: sessionId))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    // Queued messages live in the strip above the composer
                    // (like the web cockpit), not in the transcript.
                    TranscriptView(turns: store.sync.turns.filter { $0.state != .queued })
                        .padding(.vertical, 12)
                    Color.clear.frame(height: 1).id("bottom")
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: store.sync.turns.last?.lastActivityAt) {
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            footer
        }
        .background(Theme.canvas)
        .navigationTitle(store.sync.session?.title ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .task { store.sync.start() }
        .onDisappear { store.sync.stop() }
        .onChange(of: scenePhase) { _, phase in
            // Poll only while someone is looking.
            if phase == .active { store.sync.start() } else { store.sync.stop() }
        }
        .onChange(of: store.sync.connection) { _, connection in
            if connection == .gone { dismiss() }
        }
        .alert("Rename session", isPresented: $renaming) {
            TextField("Title", text: $renameDraft)
            Button("Rename") { Task { await store.rename(renameDraft) } }
            Button("Cancel", role: .cancel) {}
        }
    }

    /// The composer region: approvals and errors render as drawers FUSED to
    /// the composer's top edge (t3code's `.chat-composer-top-drawer`), the
    /// composer itself is a 22pt glass shell with a hairline.
    @ViewBuilder private var footer: some View {
        VStack(spacing: 0) {
            if case .retrying(let message) = store.sync.connection {
                ComposerDrawer(tint: Theme.statusAmber) {
                    HStack(spacing: 6) {
                        Image(systemName: "wifi.exclamationmark").font(.system(size: 11))
                        Text(message).font(Theme.metaSmall).lineLimit(2)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Theme.statusAmber)
                }
            }
            ForEach(store.sync.openRequests) { request in
                ComposerDrawer(tint: Theme.statusAmber) {
                    RequestCardView(request: request, store: store)
                }
            }
            if let error = store.sendError, store.pendingSend != nil {
                ComposerDrawer(tint: Theme.statusRed) {
                    HStack(spacing: 8) {
                        Text("Not sent — \(error)")
                            .font(Theme.metaSmall)
                            .foregroundStyle(Theme.statusRed)
                            .lineLimit(2)
                        Spacer(minLength: 0)
                        Button("Retry") { Task { await store.retryPending() } }
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Theme.text)
                            .buttonStyle(.plain)
                        Button("Discard") { store.discardPending() }
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Theme.statusRed)
                            .buttonStyle(.plain)
                    }
                }
            }
            if !store.queuedTurns.isEmpty {
                ComposerDrawer(tint: Theme.accent) {
                    QueuedStrip(
                        queued: store.queuedTurns,
                        canSendNow: store.hasRunningTurn,
                        sendNow: { runId in Task { await store.promote(runId) } },
                        withdraw: { runId in Task { await store.withdraw(runId) } }
                    )
                }
            }
            ComposerView(
                draft: $draft,
                isRunning: store.hasRunningTurn,
                send: { text in Task { await store.send(text) } },
                stop: { Task { await store.stopActiveTurn() } }
            )
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .padding(.top, 6)
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(spacing: 1) {
                Text(store.sync.session?.title ?? "Session")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                if let session = store.sync.session {
                    HStack(spacing: 4) {
                        ActivityBadge(activity: session.activity)
                        Text(session.workspace.branch ?? session.driver)
                            .font(Theme.metaSmall)
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
                    }
                }
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("Rename", systemImage: "pencil") {
                    renameDraft = store.sync.session?.title ?? ""
                    renaming = true
                }
                if store.sync.session?.settledOverride == "settled" {
                    Button("Unsettle", systemImage: "tray.and.arrow.up") {
                        Task { await store.setSettled(false) }
                    }
                } else {
                    Button("Settle", systemImage: "tray.and.arrow.down") {
                        Task { await store.setSettled(true) }
                    }
                }
                if let usage = store.sync.session?.usage {
                    Section {
                        Text(usageLine(usage))
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }

    private func usageLine(_ usage: UsageSnapshot) -> String {
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

/// A drawer that attaches above the composer and fuses with it: rounded top
/// corners only, hairline, and no gap — t3code's approval/info drawers.
struct ComposerDrawer<Content: View>: View {
    let tint: Color
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.opacity(0.06))
            .background(.ultraThinMaterial)
            .clipShape(UnevenRoundedRectangle(topLeadingRadius: Theme.radiusDrawer, topTrailingRadius: Theme.radiusDrawer))
            .overlay(
                UnevenRoundedRectangle(topLeadingRadius: Theme.radiusDrawer, topTrailingRadius: Theme.radiusDrawer)
                    .strokeBorder(Theme.border, lineWidth: 1)
            )
            .padding(.bottom, -6)
            .zIndex(0)
    }
}

/// The waiting line: messages queued behind the running turn. Each row can be
/// promoted into the running turn ("Send now") or withdrawn — the web
/// composer's queued strip, phone-sized.
struct QueuedStrip: View {
    let queued: [JournalTurn]
    let canSendNow: Bool
    let sendNow: (EngineID) -> Void
    let withdraw: (EngineID) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if queued.count > 1 {
                Text("\(queued.count) waiting")
                    .font(.system(size: 10, weight: .medium))
                    .textCase(.uppercase)
                    .foregroundStyle(Theme.textMuted)
            }
            ForEach(queued) { turn in
                HStack(spacing: 8) {
                    Image(systemName: "clock")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textMuted)
                    Text(turn.prompt)
                        .font(Theme.metaSmall)
                        .foregroundStyle(Theme.text)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                    if canSendNow {
                        Button {
                            sendNow(turn.runId)
                        } label: {
                            Image(systemName: "bolt.fill")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.accent)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Send now — the running turn hears it without stopping")
                    }
                    Button {
                        withdraw(turn.runId)
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Theme.textMuted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove this queued message")
                }
            }
        }
    }
}

/// t3code's composer: a 22pt glass shell, hairline outline, multiline field,
/// and a 32pt circular accent-filled send button.
struct ComposerView: View {
    @Binding var draft: String
    let isRunning: Bool
    let send: (String) -> Void
    let stop: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            // The ONLY place the app mentions that queueing exists — the
            // web composer's rule.
            TextField(isRunning ? "Send queues a message…" : "Ask anything…", text: $draft, axis: .vertical)
                .font(Theme.body)
                .lineLimit(1...6)
                .padding(.vertical, 10)
                .padding(.leading, 14)
            if isRunning {
                Button {
                    stop()
                } label: {
                    Image(systemName: "square.fill")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Theme.text)
                        .frame(width: 32, height: 32)
                        .background(Theme.messageSurface)
                        .clipShape(Circle())
                }
                .accessibilityLabel("Stop the running turn")
                .padding(.bottom, 4)
            }
            Button {
                let text = draft
                draft = ""
                send(text)
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(Theme.accent)
                    .clipShape(Circle())
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .opacity(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.3 : 1)
            .accessibilityLabel("Send")
            .padding(.bottom, 4)
            .padding(.trailing, 4)
        }
        .background(.ultraThinMaterial)
        .background(Theme.surface.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusComposer))
        .hairline(Theme.radiusComposer)
        .shadow(color: .black.opacity(0.12), radius: 14, y: 8)
        .zIndex(1)
    }
}
