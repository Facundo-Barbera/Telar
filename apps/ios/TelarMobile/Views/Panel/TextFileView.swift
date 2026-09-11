import SwiftUI

/// A text file: read-only monospace with line numbers for code, an editor
/// for prose. The editor's contract is the desktop's, kept exactly:
///
/// THE SHA256 PRECONDITION CHAIN. A write carries the hash the text was
/// edited against; the engine refuses when disk moved. On success the
/// baseline advances to the written file's hash, or the second keystroke
/// after a save is refused as a conflict with itself.
///
/// A REFUSAL IS A 200, not an error, and only `conflict` offers a re-read:
/// the others describe a file that is no longer editable at all.
///
/// DRAFTS OUTLIVE THE VIEW. Text is stashed with its baseline on every
/// keystroke, so a re-open writes against the hash the text was edited
/// against rather than the fresh read's. The debounced write FLUSHES on
/// disappear rather than being cancelled: the write that matters most is
/// the one that lands after the person has moved on.
struct TextFileView: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let hostId: HostID?
    let path: String
    let active: Bool
    let editable: Bool
    let onSaveState: (FilesSurface.SaveState?) -> Void

    @State private var file: WorkspaceFile?
    @State private var error: String?
    @State private var text = ""
    @State private var baseline: String?
    @State private var refusal: WorkspaceWriteRefusal?
    @State private var dirty = false
    @State private var saveTask: Task<Void, Never>?
    @AppStorage("telar.editor.wrap") private var wrap = false
    /// The read-only view's colours, one entry per line. Nil until the pass
    /// lands, and nil forever for a language nothing knows.
    @State private var highlighted: [AttributedString]?
    @Environment(\.colorScheme) private var scheme
    @FocusState private var focused: Bool

    private var draftKey: String { "telar.fileDraft.\(hostId?.uuidString ?? "local").\(sessionId).\(path)" }
    private struct Draft: Codable { var text: String; var baseline: String }

    var body: some View {
        VStack(spacing: 0) {
            FileAddressRow(path: path, detail: file.map { humanBytes($0.bytes) }, trailing: editable ? AnyView(wrapToggle) : nil)
            if let refusal { refusalBanner(refusal) }
            if let file {
                if file.binary {
                    ContentUnavailableView("Binary file", systemImage: "doc.zipper", description: Text("\(humanBytes(file.bytes)) of bytes rather than text, so nothing was sent to read."))
                } else if editable {
                    editor
                } else {
                    codeView(file)
                }
            } else if let error {
                ContentUnavailableView("Could not read this file", systemImage: "xmark.circle", description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: "\(path):\(active)") { await read() }
        .onDisappear { flush() }
    }

    // MARK: read-only code

    private func codeView(_ file: WorkspaceFile) -> some View {
        let lines = file.text.split(separator: "\n", omittingEmptySubsequences: false)
        let gutter = CGFloat(String(lines.count).count) * 7 + 12
        return ScrollView([.vertical, .horizontal]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                    HStack(alignment: .top, spacing: 0) {
                        Text("\(index + 1)")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Theme.textTertiary)
                            .frame(width: gutter, alignment: .trailing)
                            .padding(.trailing, 8)
                        // The colours arrive a beat after the text and replace
                        // it in place; nothing waits on the highlighter to draw
                        // a first frame, and an unknown language stays plain.
                        if let coloured = highlighted?[safe: index] {
                            Text(coloured)
                                .font(.system(size: 12, design: .monospaced))
                                .textSelection(.enabled)
                        } else {
                            Text(String(line))
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(Theme.text)
                                .textSelection(.enabled)
                        }
                    }
                    .frame(minHeight: 18)
                }
                if file.truncated {
                    Text("Truncated: the first \(humanBytes(file.text.utf8.count)) of \(humanBytes(file.bytes)).")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.statusAmber)
                        .padding(.top, 8)
                }
            }
            .padding(10)
        }
        .background(Theme.codeBackground)
        .task(id: "\(path):\(file.sha256):\(scheme == .dark)") {
            highlighted = await CodeHighlighter.shared.highlightedLines(
                file.text, language: CodeLanguage.named(path), dark: scheme == .dark
            )
        }
    }

    // MARK: the editor

    private var editor: some View {
        TextEditor(text: $text)
            .font(.system(size: 14, design: (path as NSString).pathExtension.lowercased() == "md" ? .default : .monospaced))
            .lineSpacing(3)
            .foregroundStyle(Theme.text)
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .focused($focused)
            .padding(.horizontal, 6)
            .onChange(of: text) { _, next in
                guard file != nil, next != file?.text || dirty else { return }
                dirty = true
                stash(next)
                scheduleSave()
            }
    }

    private var wrapToggle: some View {
        Button {
            wrap.toggle()
        } label: {
            Image(systemName: "text.word.spacing")
                .font(.system(size: 11))
                .foregroundStyle(wrap ? Theme.accent : Theme.textMuted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(wrap ? "Wrap lines on" : "Wrap lines off")
        .opacity(0)
        .frame(width: 0)
    }

    private func refusalBanner(_ refusal: WorkspaceWriteRefusal) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 11)).foregroundStyle(Theme.statusRed)
            Text(refusalCopy(refusal)).font(.system(size: 12)).foregroundStyle(Theme.statusRed)
            Spacer(minLength: 0)
            if refusal == .conflict {
                Button("Re-read from disk") { Task { await read(discardingDraft: true) } }
                    .font(.system(size: 12, weight: .medium))
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.text)
            }
        }
        .padding(10)
        .background(Theme.statusRed.opacity(0.08))
    }

    /// The desktop's four sentences, word for word.
    private func refusalCopy(_ refusal: WorkspaceWriteRefusal) -> String {
        switch refusal {
        case .conflict: "This file changed on disk while you were editing — most likely the agent wrote it. Your text has not been saved."
        case .notFound: "This file is no longer there. It was moved or deleted while you had it open."
        case .binary: "The engine reports this file as binary, so there is no text to save back."
        case .tooLarge: "This file is too large for the panel to save safely — it was only partly read, and writing it back would drop the rest."
        case .unknown: "The engine refused the write."
        }
    }

    // MARK: reads and writes

    private func read(discardingDraft: Bool = false) async {
        do {
            let fresh = try await api.sessionFile(sessionId, path: path)
            file = fresh
            error = nil
            if discardingDraft {
                UserDefaults.standard.removeObject(forKey: draftKey)
                text = fresh.text
                baseline = fresh.sha256
                dirty = false
                refusal = nil
                onSaveState(nil)
            } else if let data = UserDefaults.standard.data(forKey: draftKey), let draft = try? JSONDecoder().decode(Draft.self, from: data) {
                // THE STASHED BASELINE, not the fresh hash: the draft was
                // edited against that file, and writing it with a newer hash
                // would turn a refusal into an overwrite.
                if draft.text == fresh.text {
                    UserDefaults.standard.removeObject(forKey: draftKey)
                    text = fresh.text
                    baseline = fresh.sha256
                } else {
                    text = draft.text
                    baseline = draft.baseline
                    dirty = true
                }
            } else if !dirty {
                text = fresh.text
                baseline = fresh.sha256
            }
        } catch {
            self.error = describe(error)
        }
    }

    private func stash(_ next: String) {
        guard let baseline else { return }
        if let data = try? JSONEncoder().encode(Draft(text: next, baseline: baseline)) {
            UserDefaults.standard.set(data, forKey: draftKey)
        }
    }

    private func scheduleSave() {
        saveTask?.cancel()
        onSaveState(.saving)
        saveTask = Task {
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            await save()
        }
    }

    /// The pending write goes out now rather than being dropped.
    private func flush() {
        guard dirty, saveTask != nil else { return }
        saveTask?.cancel()
        let api = self.api, sessionId = self.sessionId, path = self.path, text = self.text, baseline = self.baseline
        Task.detached {
            guard let baseline else { return }
            _ = try? await api.writeSessionFile(sessionId, path: path, text: text, expectedSha256: baseline)
        }
    }

    private func save() async {
        guard let baseline, dirty else { return }
        let written = text
        do {
            switch try await api.writeSessionFile(sessionId, path: path, text: written, expectedSha256: baseline) {
            case .written(let fresh):
                // ADVANCE THE BASELINE, or the next keystroke is a conflict
                // with the save that just landed.
                self.baseline = fresh.sha256
                file = fresh
                refusal = nil
                if text == written {
                    dirty = false
                    UserDefaults.standard.removeObject(forKey: draftKey)
                    onSaveState(nil)
                } else {
                    stash(text)
                    scheduleSave()
                }
            case .refused(let why, _):
                refusal = why
                onSaveState(.problem)
            }
        } catch {
            self.error = describe(error)
            onSaveState(.problem)
        }
    }
}
