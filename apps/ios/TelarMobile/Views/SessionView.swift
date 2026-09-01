import SwiftUI
import PhotosUI

struct SessionView: View {
    @State private var store: SessionStore
    @State private var draft = ""
    @State private var renaming = false
    @State private var renameDraft = ""
    @State private var showChanges = false
    private let api: any EngineAPI
    private let sessionId: EngineID
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss

    init(api: any EngineAPI, sessionId: EngineID) {
        self.api = api
        self.sessionId = sessionId
        _store = State(initialValue: SessionStore(api: api, sessionId: sessionId))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    // Queued messages live below the composer (t3's queue
                    // line), not in the transcript.
                    // Queued and steering messages live in the strip under
                    // the composer; a STEERED one's content already appears
                    // inside the host turn as a user_message item — rendering
                    // the turn too is the double bubble. (Web rule, 1:1.)
                    TranscriptView(turns: store.sync.turns.filter {
                        $0.state != .queued && $0.state != .steering && $0.state != .steered
                    })
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
        .navigationDestination(isPresented: $showChanges) {
            DiffView(api: api, sessionId: sessionId)
        }
        .alert("Rename session", isPresented: $renaming) {
            TextField("Title", text: $renameDraft)
            Button("Rename") { Task { await store.rename(renameDraft) } }
            Button("Cancel", role: .cancel) {}
        }
    }

    /// t3's sticky overlay: pending cards above, then the composer on a
    /// bottom gradient scrim.
    @ViewBuilder private var footer: some View {
        VStack(spacing: 12) {
            if case .retrying(let message) = store.sync.connection {
                StatusCard(tint: Theme.statusAmber) {
                    HStack(spacing: 6) {
                        Image(systemName: "wifi.exclamationmark").font(.system(size: 11))
                        Text(message).font(.system(size: 13)).lineLimit(2)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Theme.statusAmber)
                }
            }
            ForEach(store.sync.openRequests) { request in
                StatusCard(tint: Theme.statusAmber) {
                    RequestCardView(request: request, store: store)
                }
            }
            if let error = store.sendError, store.pendingSend != nil {
                StatusCard(tint: Theme.statusRed) {
                    HStack(spacing: 8) {
                        Text("Not sent — \(error)")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.statusRed)
                            .lineLimit(2)
                        Spacer(minLength: 0)
                        Button("Retry") { Task { await store.retryPending() } }
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Theme.text)
                            .buttonStyle(.plain)
                        Button("Discard") { store.discardPending() }
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Theme.statusRed)
                            .buttonStyle(.plain)
                    }
                }
            }
            ComposerView(draft: $draft, store: store)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(alignment: .bottom) { ComposerScrim() }
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
                Button("Changes", systemImage: "plus.forwardslash.minus") {
                    showChanges = true
                }
                Button("Rename", systemImage: "pencil") {
                    renameDraft = store.sync.session?.title ?? ""
                    renaming = true
                }
                if store.sync.session?.settledOverride == "settled" {
                    Button("Un-settle", systemImage: "arrow.uturn.backward") {
                        Task { await store.setSettled(false) }
                    }
                } else {
                    Button("Settle", systemImage: "checkmark") {
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

/// t3's bottom wash: the composer floats on a vertical gradient toward the
/// canvas, not on a solid bar.
struct ComposerScrim: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let base: Color = scheme == .dark ? .black : .white
        LinearGradient(
            stops: [
                .init(color: base.opacity(0), location: 0),
                .init(color: base.opacity(0.6), location: 0.55),
                .init(color: base.opacity(0.9), location: 1),
            ],
            startPoint: .top, endPoint: .bottom
        )
        .ignoresSafeArea(edges: .bottom)
        .allowsHitTesting(false)
    }
}

/// A pending card above the composer — rounded 16, card fill washed with the
/// status tint, hairline. (t3 renders approvals as standalone cards in the
/// sticky overlay, not fused drawers.)
struct StatusCard<Content: View>: View {
    let tint: Color
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.opacity(0.06))
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Theme.border, lineWidth: 1)
            )
    }
}

/// t3 mobile's composer, ported: a capsule pill at rest that morphs into a
/// radius-20 card on focus (220ms linear, focus is the ONLY driver), with the
/// toolbar row appearing under the card and the queue line under that.
struct ComposerView: View {
    @Binding var draft: String
    let store: SessionStore

    @FocusState private var focused: Bool
    @State private var managingQueue = false
    @State private var pickedPhotos: [PhotosPickerItem] = []
    @Environment(\.colorScheme) private var scheme

    private var isRunning: Bool { store.hasRunningTurn }
    private var queued: [JournalTurn] { store.queuedTurns }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !store.pendingAttachments.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            surface
            if focused { toolbar }
            if !queued.isEmpty { queueLine }
        }
        .animation(.linear(duration: 0.22), value: focused)
        .animation(.linear(duration: 0.18), value: queued.count)
        .onChange(of: pickedPhotos) { _, items in
            guard !items.isEmpty else { return }
            pickedPhotos = []
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        await store.attach(
                            data: data,
                            name: (item.itemIdentifier ?? "photo") + ".jpg",
                            mediaType: item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"
                        )
                    }
                }
            }
        }
    }

    // MARK: the surface

    private var surface: some View {
        VStack(alignment: .leading, spacing: 0) {
            if focused && !store.pendingAttachments.isEmpty {
                attachmentStrip.padding(.bottom, 10)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Ask the agent, or run a command…", text: $draft, axis: .vertical)
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.text)
                    .lineLimit(focused ? 7 : 1)
                    .frame(minHeight: focused ? 80 : 36, alignment: focused ? .topLeading : .center)
                    .padding(.vertical, focused ? 8 : 0)
                    .focused($focused)
                    .onSubmit { submit() }
                if !focused {
                    if !store.pendingAttachments.isEmpty {
                        Text("+\(store.pendingAttachments.count)")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(Theme.textMuted2)
                            .frame(width: 30, height: 30)
                            .background(Theme.subtleStrong)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .padding(.bottom, 7)
                    }
                    ControlPillButton(
                        isRunning: isRunning, canSend: canSend,
                        action: { isRunning ? stop() : submit() }
                    )
                }
            }
        }
        .padding(.leading, focused ? 14 : 18)
        .padding(.trailing, focused ? 14 : 5)
        .padding(.vertical, focused ? 12 : 5)
        .composerGlass(cornerRadius: focused ? 20 : 27)
        .shadow(color: .black.opacity(scheme == .dark ? 0.35 : 0.12), radius: 14, y: 6)
        .onTapGesture { focused = true }
    }

    /// 72×72 radius-16 thumbs with a 22pt dark remove circle — the expanded
    /// card's strip. Files aren't previewable images here; the name carries.
    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(store.pendingAttachments) { attachment in
                    ZStack(alignment: .topTrailing) {
                        VStack(spacing: 6) {
                            Image(systemName: attachment.mediaType.hasPrefix("image/") ? "photo" : "doc")
                                .font(.system(size: 20))
                                .foregroundStyle(Theme.textMuted2)
                            Text(attachment.name)
                                .font(.system(size: 10))
                                .foregroundStyle(Theme.textMuted2)
                                .lineLimit(1)
                        }
                        .frame(width: 72, height: 72)
                        .background(Theme.subtle)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        Button {
                            store.removeAttachment(attachment.id)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 22, height: 22)
                                .background(Color.black.opacity(0.55))
                                .clipShape(Circle())
                        }
                        .padding(4)
                        .accessibilityLabel("Remove \(attachment.name)")
                    }
                }
                if store.uploading {
                    ProgressView()
                        .frame(width: 72, height: 72)
                        .background(Theme.subtle)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
        }
    }

    // MARK: the toolbar (expanded only)

    private var toolbar: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    PhotosPicker(selection: $pickedPhotos, maxSelectionCount: 8, matching: .images) {
                        Image(systemName: "plus")
                            .font(.system(size: 16))
                            .foregroundStyle(Theme.text)
                            .frame(width: 44, height: 44)
                            .background(Theme.subtle)
                            .clipShape(Circle())
                            .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
                    }
                    .accessibilityLabel("Attach photos")
                    if isRunning {
                        ToolbarPill(variant: .danger) {
                            stop()
                        } label: {
                            Image(systemName: "stop.fill").font(.system(size: 14))
                        }
                        .accessibilityLabel("Stop the running turn")
                    }
                    modelPill
                    labeledPill(icon: "slider.horizontal.3",
                                label: ComposerView.runtimeModes.first { $0.0 == runtimeMode }?.1 ?? "Configuration") {
                        ForEach(ComposerView.runtimeModes, id: \.0) { mode, label in
                            Button {
                                Task { await store.setRuntimeMode(mode) }
                            } label: {
                                menuRow(label, selected: mode == runtimeMode)
                            }
                        }
                    }
                }
            }
            Button {
                submit()
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(canSend ? Theme.primaryGlyph : Theme.textMuted2)
                    .frame(width: 44, height: 44)
                    .background(canSend ? Theme.primaryFill : Theme.subtleStrong)
                    .clipShape(Circle())
            }
            .disabled(!canSend)
            .accessibilityLabel(isRunning || !queued.isEmpty ? "Queue" : "Send")
        }
        .padding(.top, 8)
        .padding(.bottom, 2)
    }

    private var runtimeMode: String {
        store.sync.session?.runtimeMode ?? "approval-required"
    }

    /// The fused provider+model pill — driver fixed (a session belongs to
    /// its provider), everything else changeable per turn.
    private var modelPill: some View {
        let driver = store.sync.session?.driver ?? "claude"
        let selection = store.sync.session?.model
        return ModelPillView(
            catalogues: store.catalogue.map { [driver: $0] } ?? [:],
            choice: ModelChoice(
                driver: driver, model: selection?.model,
                effort: selection?.effort, fastMode: selection?.fastMode
            ),
            driversSwitchable: false,
            onChange: { next in Task { await store.setModelChoice(next) } }
        )
        .task { await store.loadModels() }
    }

    @ViewBuilder private func menuRow(_ label: String, selected: Bool) -> some View {
        if selected {
            Label(label, systemImage: "checkmark")
        } else {
            Text(label)
        }
    }

    private func labeledPill<Items: View>(icon: String, label: String, @ViewBuilder items: () -> Items) -> some View {
        Menu {
            items()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon).font(.system(size: 14))
                Text(label)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .medium))
            }
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 14)
            .frame(height: 44)
            .frame(maxWidth: 172)
            .background(Theme.subtle)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
        }
    }

    // MARK: the queue

    private var queueLine: some View {
        let steering = queued.filter { $0.state == .steering }
        let waiting = queued.filter { $0.state == .queued }
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                managingQueue.toggle()
            } label: {
                HStack(spacing: 6) {
                    if !steering.isEmpty { SteppedPulseDot(color: Theme.statusSky) }
                    // Steering is NOT silent: the injection waits for a safe
                    // boundary in the provider stream, which can take a
                    // while — a vanished message reads as a dropped one.
                    Text(steering.isEmpty
                         ? "\(waiting.count) queued message\(waiting.count == 1 ? "" : "s") will send automatically."
                         : "Sending into the running turn…")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textMuted2)
                }
            }
            .buttonStyle(.plain)
            if managingQueue {
                ForEach(queued) { turn in
                    let sending = turn.state == .steering
                    HStack(spacing: 10) {
                        Text(turn.prompt)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.text)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if sending {
                            Text("sending")
                                .font(.system(size: 10, weight: .medium))
                                .textCase(.uppercase)
                                .foregroundStyle(Theme.statusSky)
                        } else {
                            if isRunning {
                                Button {
                                    Task { await store.promote(turn.runId) }
                                } label: {
                                    Image(systemName: "bolt.fill")
                                        .font(.system(size: 12))
                                        .foregroundStyle(Theme.text)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Send now — the running turn hears it without stopping")
                            }
                            Button {
                                Task { await store.withdraw(turn.runId) }
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(Theme.textMuted2)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove this queued message")
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Theme.subtle)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
    }

    private func submit() {
        guard canSend else { return }
        let text = draft
        draft = ""
        focused = false
        Task { await store.send(text) }
    }

    private func stop() {
        Task { await store.stopActiveTurn() }
    }

    static let runtimeModes: [(String, String)] = [
        ("approval-required", "Supervised"),
        ("auto-accept-edits", "Auto-accept edits"),
        ("auto", "Auto"),
        ("full-access", "Full access"),
    ]
}

/// The collapsed pill's 44pt circular control: primary send at rest, danger
/// stop while running — the stop REPLACES send in the pill (t3's ControlPill).
struct ControlPillButton: View {
    let isRunning: Bool
    let canSend: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: isRunning ? "stop.fill" : "arrow.up")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(isRunning ? Theme.dangerGlyph : (canSend ? Theme.primaryGlyph : Theme.textMuted2))
                .frame(width: 44, height: 44)
                .background(isRunning ? Theme.dangerFill : (canSend ? Theme.primaryFill : Theme.subtleStrong))
                .clipShape(Circle())
        }
        .disabled(!isRunning && !canSend)
        .accessibilityLabel(isRunning ? "Stop the running turn" : "Send")
    }
}

/// A 44pt toolbar pill (t3's ComposerToolbarButton): subtle fill, hairline,
/// full radius; danger variant for stop.
struct ToolbarPill<Label: View>: View {
    enum Variant { case normal, danger }
    let variant: Variant
    let action: () -> Void
    @ViewBuilder let label: Label

    init(variant: Variant = .normal, action: @escaping () -> Void, @ViewBuilder label: () -> Label) {
        self.variant = variant
        self.action = action
        self.label = label()
    }

    var body: some View {
        Button(action: action) {
            label
                .foregroundStyle(variant == .danger ? Theme.dangerGlyph : Theme.text)
                .frame(width: 44, height: 44)
                .background(variant == .danger ? Theme.dangerFill : Theme.subtle)
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
        }
    }
}

extension View {
    /// t3's ComposerSurface: liquid glass on iOS 26+, an opaque near-material
    /// fallback elsewhere. Shadow belongs to the CALLER (a clipped surface
    /// would clip its own shadow).
    @ViewBuilder func composerGlass(cornerRadius: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        // `#available` guards the RUNTIME; the compiler gate guards the SDK —
        // a CI runner on an older Xcode has no `glassEffect` symbol at all,
        // and its builds fall to the opaque surface everywhere.
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular.interactive(), in: shape)
        } else {
            self.background(Theme.composerSurface)
                .clipShape(shape)
                .overlay(shape.strokeBorder(Theme.border, lineWidth: 1))
        }
        #else
        self.background(Theme.composerSurface)
            .clipShape(shape)
            .overlay(shape.strokeBorder(Theme.border, lineWidth: 1))
        #endif
    }
}
