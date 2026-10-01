import SwiftUI
import PhotosUI

struct ComposerView: View {
    @Binding var draft: String

    let focus: Binding<Bool>

    let host: any ComposerHost

    var api: (any EngineAPI)?

    var controls = ComposerControls()

    var onSend: () -> Void = {}

    private var focused: Bool { focus.wrappedValue }
    @State private var managingQueue = false
    @State private var pickedPhotos: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    @State private var showingStash = false

    @State private var note: String?
    @State private var dropping = false

    @State private var dictation: Dictation?

    @State private var strip = DictationStrip()

    @State private var caretRect: CGRect?
    @State private var field = ComposerField()

    @State private var canDictate = false
    @State private var skillsCache = ComposerSkillsCache()
    @State private var trigger: ComposerTrigger?
    @State private var activeSuggestion = 0
    @State private var dismissedDraft: String?
    @Environment(\.colorScheme) private var scheme
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 44
    @ScaledMetric(relativeTo: .body) private var pillInset: CGFloat = 12.5

    private var isRunning: Bool { host.isRunning }
    private var queued: [JournalTurn] { host.queuedTurns }

    private var isListening: Bool { dictation?.phase == .listening }

    private var canSend: Bool {
        SessionDraft.canSend(text: draft, mediaTypes: host.pendingAttachments.map(\.mediaType))
    }

    private var slot: ComposerSlot {
        ComposerSlot.resolve(canSend: canSend, running: isRunning)
    }

    var body: some View {
        VStack(spacing: 0) {
            if let note {
                Text(note)
                    .font(.system(Theme.footnote))
                    .foregroundStyle(Theme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 6)
            }

            if let dictation, let refusal = dictation.error {
                Text(refusal)
                    .font(.system(Theme.footnote))
                    .foregroundStyle(Theme.statusRed)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 6)
            }
            if showsSuggestions {
                ComposerSuggestionList(rows: suggestions, active: activeSuggestion, loading: loadingSkills, onPick: pick)
                    .padding(.bottom, 8)
                    .transition(.opacity)
            }
            if !host.pendingAttachments.isEmpty || host.uploading {
                attachmentStrip.padding(.bottom, 8)
            }
            HStack(alignment: .bottom, spacing: 8) {
                plusMenu
                pill
                slotButton
            }
            if !queued.isEmpty { queueLine }
        }
        .animation(.linear(duration: 0.18), value: queued.count)
        .animation(.linear(duration: 0.18), value: host.pendingAttachments.count)
        .animation(.linear(duration: 0.12), value: showsSuggestions)
        .onChange(of: draft) { _, _ in retrigger(edited: true) }
        .onChange(of: caretRect) { _, _ in retrigger(edited: false) }
        .onChange(of: isListening) { _, _ in retrigger(edited: false) }
        .task(id: trigger == nil ? nil : host.skillsKey) {
            guard trigger != nil, let key = host.skillsKey else { return }
            let host = host
            await skillsCache.load(key) { try await host.readSkills() }
        }
        .onDrop(of: ComposerIntake.accepted, isTargeted: $dropping) { providers in
            intake(providers)
            return true
        }

        .onAppear {
            guard dictation == nil, let api else { return }
            let live = Dictation(api: api)
            ComposerLog.audio = AudioSessionClaim.describe

            live.onStart = {
                strip = DictationStrip()
                ComposerLog.shared.record(ComposerLogEntry(source: .dictation, event: "start"))
            }
            live.onWords = { heard in
                strip.hear(heard)
                if heard.final || !strip.settled.isEmpty { commitStrip() }
            }
            live.onEnd = {
                strip.flush()
                commitStrip(finishing: true)
                strip = DictationStrip()
                ComposerLog.shared.record(ComposerLogEntry(source: .dictation, event: "stop"))
            }
            dictation = live
        }

        .task {
            guard let api else { return }
            let answer = try? await api.dictation()
            canDictate = DictationProvider.canDictateHere(answer?.dictation.provider ?? DictationProvider.off)
        }

        .onDisappear { dictation?.stop() }
        .sheet(isPresented: $showingStash) {
            StashSheet { entry in restore(entry) }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $pickedPhotos, maxSelectionCount: 8, matching: .images)
        .onChange(of: pickedPhotos) { _, items in
            guard !items.isEmpty else { return }
            pickedPhotos = []
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        await host.attach(
                            data: data,
                            name: (item.itemIdentifier ?? "photo") + ".jpg",
                            mediaType: item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"
                        )
                    }
                }
            }
        }
    }

    private var pill: some View {
        let shape = RoundedRectangle(cornerRadius: Theme.radiusComposer, style: .continuous)
        return VStack(alignment: .leading, spacing: 0) {
            if isListening { heardStrip }
            HStack(alignment: .bottom, spacing: 0) {
                fieldView
                micButton
            }
        }
        .frame(minHeight: rowHeight)
        .composerGlass(cornerRadius: Theme.radiusComposer)
        .shadow(color: .black.opacity(scheme == .dark ? 0.35 : 0.12), radius: 14, y: 6)
        .contentShape(shape)
        .onTapGesture { focus.wrappedValue = true }
        .contextMenu {
            Button("Clear draft", systemImage: "eraser") { clearDraft() }
                .disabled(draft.isEmpty)
            Button("Stash draft", systemImage: "tray.and.arrow.down", action: stashDraft)
                .disabled(!hasDraftText)
        }
        .overlay {
            if dropping { shape.strokeBorder(Theme.accent, lineWidth: 2) }
        }
    }

    private var heardStrip: some View {
        Text(strip.shown.isEmpty ? "Listening…" : strip.shown)
            .font(.system(Theme.footnote))
            .foregroundStyle(strip.shown.isEmpty ? Theme.textMuted : Theme.accent)
            .lineLimit(3)
            .truncationMode(.head)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .accessibilityLabel(strip.shown.isEmpty ? "Listening" : "Heard: \(strip.shown)")
    }

    private func commitStrip(finishing: Bool = false) {
        guard let text = strip.take() else { return }
        if field.commit(text, finishing: finishing) { return }
        if field.isMounted {
            strip.hold(text)
        } else {
            draft = DictationStrip.appending(text, to: draft)
        }
    }

    private var fieldView: some View {
        ComposerTextView(
            text: $draft,
            placeholder: host.placeholder,
            focused: focus,
            maxLines: ComposerGrowth.maxLines,
            listening: isListening,
            caretRect: $caretRect,
            field: field,
            onTouch: {
                guard isListening else { return }
                strip.flush()
                commitStrip()
            },
            suggesting: showsSuggestions && !suggestions.isEmpty,
            onSuggestionKey: suggestionKey,
            onPaste: { intake($0) }
        )
        .overlay(alignment: .topLeading) {
            if isListening, let caretRect {
                DictationCaretPill(language: dictation?.language)
                    .offset(
                        x: DictationCaretPill.origin(for: caretRect).x,
                        y: DictationCaretPill.origin(for: caretRect).y
                    )
                    .transition(.opacity)
            }
        }
        .animation(.linear(duration: 0.12), value: isListening)
        .padding(.leading, 16)
        .padding(.trailing, showsMic ? 0 : 16)
        .padding(.vertical, pillInset)
    }

    private var showsMic: Bool { dictation != nil && canDictate }

    @ViewBuilder private var micButton: some View {
        if let dictation, canDictate {
            Button {
                if !focused { focus.wrappedValue = true }
                dictation.toggle()
            } label: {
                Image(systemName: isListening ? "mic.fill" : "mic")
                    .contentTransition(.symbolEffect(.replace))
                    .symbolEffect(.pulse, isActive: isListening)
                    .foregroundStyle(isListening ? Theme.statusRed : Theme.textMuted)
                    .scaledGlyphBox(44, glyph: 17, weight: .medium)
            }
            .disabled(dictation.phase == .starting)
            .accessibilityLabel(isListening ? "Stop dictating" : "Dictate")
        }
    }

    private func intake(_ providers: [NSItemProvider]) {
        Task {
            let (files, refusals) = await composerFiles(from: providers)
            for file in files {
                await host.attach(data: file.data, name: file.name, mediaType: file.mediaType)
            }
            note = refusals.isEmpty ? nil : refusals.joined(separator: " ")
        }
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(host.pendingAttachments) { attachment in
                    AttachmentChip(
                        name: attachment.name,
                        mediaType: attachment.mediaType,
                        preview: host.attachmentPreviews[attachment.id],
                        onRemove: { host.removeAttachment(attachment.id) }
                    )
                }
                if host.uploading {
                    ProgressView()
                        .frame(width: 72, height: 72)
                        .background(Theme.subtle)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
        }
    }

    private var hasDraftText: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private var plusMenu: some View {
        Menu {
            Section {
                controls.model
                controls.options
            }
            .environment(\.composerPillsInMenu, true)
            Section {
                Button("Commands and skills", systemImage: "command", action: openCommands)
                Button("Attach photos", systemImage: "photo") { pickingPhotos = true }
                if hasDraftText { Button("Stash this prompt", systemImage: "tray.and.arrow.down", action: stashDraft) }
                Button("Show stashed prompts", systemImage: "tray.full") { showingStash = true }
            }
            if isRunning && slot != .stop {
                Button("Stop the running turn", systemImage: "stop.fill", role: .destructive, action: stop)
            }
        } label: {
            Image(systemName: "plus")
                .foregroundStyle(Theme.text)
                .scaledGlyphBox(44, glyph: 18, weight: .medium)
                .composerGlass(cornerRadius: rowHeight / 2)
        }
        .menuOrder(.fixed)
        .accessibilityLabel("More")
    }

    private var slotButton: some View {
        let primary = slot == .send && canSend
        let danger = slot == .stop
        return Button {
            slot == .stop ? stop() : submit()
        } label: {
            Image(systemName: slot == .stop ? "stop.fill" : "arrow.up")
                .contentTransition(.symbolEffect(.replace))
                .foregroundStyle(primary ? Theme.primaryGlyph : danger ? Theme.dangerGlyph : Theme.textMuted)
                .scaledGlyphBox(44, glyph: 17, weight: .semibold)
                .background(primary ? Theme.primaryFill : danger ? Theme.dangerFill : Theme.subtleStrong, in: Circle())
        }
        .disabled(slot == .send && !canSend)
        .animation(.spring(duration: 0.25), value: slot)
        .animation(.spring(duration: 0.25), value: canSend)
        .accessibilityLabel(slot == .stop ? "Stop the running turn" : isRunning || !queued.isEmpty ? "Queue" : "Send")
    }

    private var queueLine: some View {
        let steering = queued.filter { $0.state == .steering }
        let waiting = queued.filter { $0.state == .queued }
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                managingQueue.toggle()
            } label: {
                HStack(spacing: 6) {
                    if !steering.isEmpty { SteppedPulseDot(color: Theme.statusSky) }

                    Text(steering.isEmpty
                         ? "\(waiting.count) queued message\(waiting.count == 1 ? "" : "s") will send automatically."
                         : "Sending into the running turn…")
                        .font(.system(Theme.footnote))
                        .foregroundStyle(Theme.textMuted)
                }
            }
            .buttonStyle(.plain)
            if managingQueue {
                ForEach(queued) { turn in
                    let sending = turn.state == .steering
                    HStack(spacing: 10) {
                        Text(turn.prompt)
                            .font(.system(Theme.footnote))
                            .foregroundStyle(Theme.text)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if sending {
                            Text("sending")
                                .font(.system(Theme.caption, weight: .medium))
                                .textCase(.uppercase)
                                .foregroundStyle(Theme.statusSky)
                        } else {
                            if isRunning && host.canPromoteQueued {
                                Button {
                                    Task { await host.promote(turn.runId) }
                                } label: {
                                    Image(systemName: "bolt.fill")
                                        .font(.system(Theme.footnote))
                                        .foregroundStyle(Theme.text)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Send now — the running turn hears it without stopping")
                            }
                            Button {
                                Task { await host.withdraw(turn.runId) }
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(Theme.caption, weight: .medium))
                                    .foregroundStyle(Theme.textMuted)
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

    private var suggestions: [ComposerCompletion] {
        guard let trigger, dismissedDraft != draft else { return [] }
        let skills = host.skillsKey.map { skillsCache.skills(for: $0) } ?? .empty
        return ComposerCompletions.list(for: trigger, context: host.commandContext, skills: skills)
    }

    private var loadingSkills: Bool {
        guard let key = host.skillsKey else { return false }
        return skillsCache.loading && skillsCache.key != key
    }

    private var showsSuggestions: Bool {
        focused && trigger != nil && dismissedDraft != draft && (!suggestions.isEmpty || loadingSkills)
    }

    private func retrigger(edited: Bool) {
        let next = isListening ? nil : ComposerTrigger.detect(in: draft, caret: field.location(in: draft) ?? (draft as NSString).length)
        if edited { dismissedDraft = nil }
        if edited || next?.kind != trigger?.kind { activeSuggestion = 0 }
        if next != trigger { trigger = next }
    }

    private func suggestionKey(_ key: ComposerSuggestionKey) {
        let rows = suggestions
        guard !rows.isEmpty else { return }
        switch key {
        case .up: activeSuggestion = (activeSuggestion - 1 + rows.count) % rows.count
        case .down: activeSuggestion = (activeSuggestion + 1) % rows.count
        case .accept: pick(rows[min(activeSuggestion, rows.count - 1)])
        case .dismiss: dismissedDraft = draft
        }
    }

    private func pick(_ completion: ComposerCompletion) {
        guard let trigger else { return }
        var inserted = ""
        if case .insert(let text) = completion.action { inserted = text + " " }
        self.trigger = nil
        activeSuggestion = 0
        draft = trigger.replace(in: draft, with: inserted).text
        if inserted.isEmpty {
            let host = host
            Task { await host.perform(completion.action) }
        }
    }

    private func openCommands() {
        draft = ComposerTrigger.opening(draft)
        dismissedDraft = nil
        focus.wrappedValue = true
    }

    private func submit() {
        guard canSend else { return }
        let text = draft
        draft = ""
        focus.wrappedValue = false

        onSend()
        Task { await host.send(text) }
    }

    private func stop() {
        Task { await host.stop() }
    }

    private func clearDraft() {
        guard !draft.isEmpty else { return }
        draft = ""
        note = nil
    }

    private func stashDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let ok = PromptStash.shared.stash(StashEntry(id: UUID().uuidString, at: Timestamp(Date().timeIntervalSince1970 * 1000), prompt: text, images: []))
        guard ok else {
            note = "There was no room to stash this. Nothing was taken from the box."
            return
        }
        draft = ""
        note = host.pendingAttachments.isEmpty ? nil : "Stashed the text. The photos stay here."
    }

    private func restore(_ entry: StashEntry) {
        guard let taken = PromptStash.shared.take(entry.id, room: 0) else { return }
        draft = StashRules.appendPrompt(draft, taken.prompt)
        note = taken.left > 0 ? "\(taken.left == 1 ? "1 image is" : "\(taken.left) images are") still in the stash — this app cannot restore pictures yet." : nil
        focus.wrappedValue = true
    }
}
