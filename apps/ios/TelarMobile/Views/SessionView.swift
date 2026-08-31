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
                    TranscriptView(turns: store.sync.turns)
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

    @ViewBuilder private var footer: some View {
        VStack(spacing: 8) {
            if case .retrying(let message) = store.sync.connection {
                Label(message, systemImage: "wifi.exclamationmark")
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(store.sync.openRequests) { request in
                RequestCardView(request: request, store: store)
            }
            if let error = store.sendError, store.pendingSend != nil {
                HStack {
                    Text("Not sent — \(error)")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                    Spacer()
                    Button("Retry") { Task { await store.retryPending() } }
                        .controlSize(.small)
                    Button("Discard", role: .destructive) { store.discardPending() }
                        .controlSize(.small)
                }
            }
            ComposerView(
                draft: $draft,
                isRunning: store.hasActiveTurn,
                send: { text in Task { await store.send(text) } },
                stop: { Task { await store.stopActiveTurn() } }
            )
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(spacing: 1) {
                Text(store.sync.session?.title ?? "Session")
                    .font(.headline)
                    .lineLimit(1)
                if let session = store.sync.session {
                    HStack(spacing: 4) {
                        ActivityBadge(activity: session.activity)
                        Text(session.workspace.branch ?? session.driver)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
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

struct ComposerView: View {
    @Binding var draft: String
    let isRunning: Bool
    let send: (String) -> Void
    let stop: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .textFieldStyle(.roundedBorder)
            if isRunning {
                Button {
                    stop()
                } label: {
                    Image(systemName: "stop.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.red)
                }
                .accessibilityLabel("Stop the running turn")
            }
            Button {
                let text = draft
                draft = ""
                send(text)
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send")
        }
    }
}
