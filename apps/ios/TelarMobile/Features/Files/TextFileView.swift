import SwiftUI

struct TextFileView: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let hostId: HostID?
    let path: String
    let active: Bool
    let editable: Bool

    var root: String?
    let onSaveState: (FilesSurface.SaveState?) -> Void

    @State private var file: WorkspaceFile?
    @State private var error: String?
    @State private var text = ""
    @State private var baseline: String?
    @State private var refusal: WorkspaceWriteRefusal?
    @State private var dirty = false
    @State private var saveTask: Task<Void, Never>?
    @AppStorage("telar.editor.wrap") private var wrap = false

    @State private var highlighted: [AttributedString]?

    @State private var viewport: CGSize = .zero

    @State private var sideways: CGFloat = 0
    @Environment(\.colorScheme) private var scheme
    @Environment(\.panel) private var panel
    @FocusState private var focused: Bool

    private var draftKey: String { "telar.fileDraft.\(hostId?.uuidString ?? "local").\(sessionId).\(path)" }
    private struct Draft: Codable { var text: String; var baseline: String }

    var body: some View {
        VStack(spacing: 0) {
            FileAddressRow(path: path, detail: file.map { humanBytes($0.bytes) })
                .contextMenu { addressMenu }
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

    private func codeView(_ file: WorkspaceFile) -> some View {
        let lines = file.text.split(separator: "\n", omittingEmptySubsequences: false)
        let gutter = CGFloat(String(lines.count).count) * 7 + 12
        let content = CodeLayout.contentWidth(
            columns: CodeLayout.widestLineColumns(file.text),
            advance: CodeLayout.advance(ofSize: 12)
        ) + gutter + 8
        return ScrollView(wrap ? [.vertical] : [.vertical, .horizontal]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                    HStack(alignment: .top, spacing: 0) {
                        Text("\(index + 1)")
                            .font(.system(Theme.caption, design: .monospaced))
                            .foregroundStyle(Theme.textMuted)
                            .frame(width: gutter, alignment: .trailing)
                            .padding(.trailing, 8)

                            .frame(maxHeight: .infinity, alignment: .top)
                            .background(Theme.codeBackground)
                            .offset(x: wrap ? 0 : sideways)
                            .zIndex(1)

                        if let coloured = highlighted?[safe: index] {
                            Text(coloured)
                                .font(.system(Theme.footnote, design: .monospaced))
                                .lineLimit(wrap ? nil : 1)
                                .textSelection(.enabled)
                        } else {
                            Text(String(line))
                                .font(.system(Theme.footnote, design: .monospaced))
                                .foregroundStyle(Theme.text)
                                .lineLimit(wrap ? nil : 1)
                                .textSelection(.enabled)
                        }
                    }
                    .frame(minHeight: 18)

                    .fixedSize(horizontal: !wrap, vertical: false)
                }
                if file.truncated {
                    Text("Truncated: the first \(humanBytes(file.text.utf8.count)) of \(humanBytes(file.bytes)).")
                        .font(.system(Theme.caption))
                        .foregroundStyle(Theme.statusAmber)
                        .padding(.top, 8)
                }
            }
            .padding(10)

            .frame(minWidth: wrap ? viewport.width : max(content, viewport.width),
                   minHeight: viewport.height, alignment: .topLeading)
        }
        .onGeometryChange(for: CGSize.self) { $0.size } action: { viewport = $0 }
        .onScrollGeometryChange(for: CGFloat.self) { max(0, $0.contentOffset.x) } action: { _, offset in
            sideways = offset
        }

        .interactivePopDisabled(!wrap && sideways > 0)
        .background(Theme.codeBackground)
        .task(id: "\(path):\(file.sha256):\(scheme == .dark)") {
            highlighted = await CodeHighlighter.shared.highlightedLines(
                file.text, language: CodeLanguage.named(path), dark: scheme == .dark
            )
        }
    }

    private var editor: some View {
        TextEditor(text: $text)
            .font(.system(Theme.subhead, design: (path as NSString).pathExtension.lowercased() == "md" ? .default : .monospaced))
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

    @ViewBuilder private var addressMenu: some View {
        if let absolute = workspaceFilePath(root, path) {
            Button("Copy path", systemImage: "doc.on.doc") { UIPasteboard.general.string = absolute }
        }
        Button("Copy relative path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
        Divider()
        Button("Re-read from disk", systemImage: "arrow.clockwise") { Task { await read(discardingDraft: true) } }
        Toggle(isOn: $wrap) { Label("Wrap lines", systemImage: "text.word.spacing") }
        if let panel {
            Divider()
            Button("Insert as a reference", systemImage: "text.badge.plus") {
                panel.insertReference(ComposerReference.file(path))
            }
        }
    }

    private func refusalBanner(_ refusal: WorkspaceWriteRefusal) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle").font(.system(Theme.caption)).foregroundStyle(Theme.statusRed)
            Text(refusalCopy(refusal)).font(.system(Theme.footnote)).foregroundStyle(Theme.statusRed)
            Spacer(minLength: 0)
            if refusal == .conflict {
                Button("Re-read from disk") { Task { await read(discardingDraft: true) } }
                    .font(.system(Theme.footnote, weight: .medium))
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.text)
            }
        }
        .padding(10)
        .background(Theme.statusRed.opacity(0.08))
    }

    private func refusalCopy(_ refusal: WorkspaceWriteRefusal) -> String {
        switch refusal {
        case .conflict: "This file changed on disk while you were editing — most likely the agent wrote it. Your text has not been saved."
        case .notFound: "This file is no longer there. It was moved or deleted while you had it open."
        case .binary: "The engine reports this file as binary, so there is no text to save back."
        case .tooLarge: "This file is too large for the panel to save safely — it was only partly read, and writing it back would drop the rest."
        case .unknown: "The engine refused the write."
        }
    }

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
