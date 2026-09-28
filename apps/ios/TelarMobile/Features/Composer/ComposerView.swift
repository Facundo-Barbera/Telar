import SwiftUI
import PhotosUI

struct ComposerView: View {
    @Binding var draft: String

    let focus: Binding<Bool>

    let host: any ComposerHost

    var api: (any EngineAPI)?

    var controls: AnyView = AnyView(EmptyView())

    var onSend: () -> Void = {}

    private var focused: Bool { focus.wrappedValue }
    @State private var managingQueue = false
    @State private var pickedPhotos: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    @State private var showingStash = false

    @State private var note: String?
    @State private var dropping = false

    @State private var dictation: Dictation?

    @State private var interim: Range<Int>?

    @State private var caretRect: CGRect?

    @State private var canDictate = false
    @Environment(\.colorScheme) private var scheme

    private var isRunning: Bool { host.isRunning }
    private var queued: [JournalTurn] { host.queuedTurns }

    private var isListening: Bool { dictation?.phase == .listening }

    private var canSend: Bool {
        SessionDraft.canSend(text: draft, mediaTypes: host.pendingAttachments.map(\.mediaType))
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
            surface
            if focused { toolbar }
            if !queued.isEmpty { queueLine }
        }
        .animation(.linear(duration: 0.22), value: focused)
        .animation(.linear(duration: 0.18), value: queued.count)

        .onAppear {
            guard dictation == nil, let api else { return }
            let live = Dictation(api: api)

            let box = $draft

            let words = DictationDraftBox()
            live.onWords = { heard in
                box.wrappedValue = words.write(heard, into: box.wrappedValue)

                interim = words.unconfirmed
            }
            live.onEnd = {
                words.forget()

                interim = nil
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

    private var surface: some View {
        VStack(alignment: .leading, spacing: 0) {
            if focused && !host.pendingAttachments.isEmpty {
                attachmentStrip.padding(.bottom, 10)
            }

            HStack(alignment: focused ? .bottom : .center, spacing: 8) {
                ComposerTextView(
                    text: $draft,
                    placeholder: host.placeholder,
                    focused: focus,
                    maxLines: focused ? 7 : 1,
                    listening: isListening,
                    interim: interim,
                    caretRect: $caretRect,
                    onPaste: { intake($0) }
                )
                .frame(minHeight: focused ? 80 : 44, alignment: focused ? .topLeading : .leading)
                .padding(.vertical, focused ? 8 : 0)

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
                if !focused {
                    if !host.pendingAttachments.isEmpty {
                        Text("+\(host.pendingAttachments.count)")
                            .font(.system(Theme.footnote, weight: .bold))
                            .foregroundStyle(Theme.textMuted)
                            .frame(width: 30, height: 30)
                            .background(Theme.subtleStrong)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
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
        .composerGlass(cornerRadius: focused ? Theme.radiusComposerFocused : Theme.radiusComposerRest)
        .shadow(color: .black.opacity(scheme == .dark ? 0.35 : 0.12), radius: 14, y: 6)

        .contentShape(RoundedRectangle(cornerRadius: focused ? Theme.radiusComposerFocused : Theme.radiusComposerRest, style: .continuous))
        .onTapGesture { focus.wrappedValue = true }

        .contextMenu {
            Button("Clear draft", systemImage: "eraser") { clearDraft() }
                .disabled(draft.isEmpty)
            Button("Stash draft", systemImage: "tray.and.arrow.down", action: stashDraft)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }

        .onDrop(of: ComposerIntake.accepted, isTargeted: $dropping) { providers in
            intake(providers)
            return true
        }
        .overlay {
            if dropping {
                RoundedRectangle(cornerRadius: focused ? Theme.radiusComposerFocused : Theme.radiusComposerRest, style: .continuous)
                    .strokeBorder(Theme.accent, lineWidth: 2)
            }
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

    private var toolbar: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    Button {
                        pickingPhotos = true
                    } label: {
                        Image(systemName: "plus")
                            .foregroundStyle(Theme.text)
                            .scaledGlyphBox(44, glyph: 16)
                            .background(Theme.subtle)
                            .clipShape(Circle())
                            .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
                    }
                    .accessibilityLabel("Attach photos")

                    StashButton(hasDraft: !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                                onStash: stashDraft, onOpen: { showingStash = true })

                    if let dictation, canDictate {
                        ToolbarPill(variant: dictation.phase == .listening ? .danger : .normal) {
                            dictation.toggle()
                        } label: {
                            Image(systemName: dictation.phase == .listening ? "mic.fill" : "mic")
                                .scaledGlyph(16)

                                .symbolEffect(.pulse, isActive: dictation.phase == .listening)
                        }
                        .accessibilityLabel(dictation.phase == .listening ? "Stop dictating" : "Dictate")
                        .disabled(dictation.phase == .starting)
                    }
                    if isRunning {
                        ToolbarPill(variant: .danger) {
                            stop()
                        } label: {
                            Image(systemName: "stop.fill").scaledGlyph(14)
                        }
                        .accessibilityLabel("Stop the running turn")
                    }

                    controls
                }
            }
            Button {
                submit()
            } label: {
                Image(systemName: "arrow.up")
                    .foregroundStyle(canSend ? Theme.primaryGlyph : Theme.textMuted)
                    .scaledGlyphBox(44, glyph: 16, weight: .semibold)
                    .background(canSend ? Theme.primaryFill : Theme.subtleStrong)
                    .clipShape(Circle())
            }
            .disabled(!canSend)
            .accessibilityLabel(isRunning || !queued.isEmpty ? "Queue" : "Send")
        }
        .padding(.top, 8)
        .padding(.bottom, 2)
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
