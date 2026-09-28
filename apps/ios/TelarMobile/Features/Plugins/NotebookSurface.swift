import SwiftUI

struct NotebookSurface: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let hostId: HostID?
    let path: String
    let active: Bool

    @State private var notebook: NotebookRead?
    @State private var failure: NotebookReadFailure?
    @State private var problem: String?
    @State private var kernel: KernelState = .none
    @State private var running: Set<String> = []
    @State private var runningAll = false
    @State private var acting = false
    @State private var editing: String?
    @State private var drafts: [String: String] = [:]
    @State private var saveTasks: [String: Task<Void, Never>] = [:]
    @State private var lightbox: EngineID?

    @ScaledMetric(relativeTo: .body) private var gutter: CGFloat = 44

    @State private var selected: String?

    @State private var collapsedOutputs: Set<String> = []
    @FocusState private var focusedCell: String?

    @State private var saved = false
    @Environment(\.kernelSignals) private var signals

    @State private var didFirstRead = false

    var body: some View {
        VStack(spacing: 0) {
            header
            if let problem { problemBanner(problem) }
            if let notebook {
                if let failure { staleBanner(failure) }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(notebook.cells) { cell in
                            cellView(cell)

                            if selected == cell.id { insertBar(after: cell.id) }
                        }
                        addBar
                    }
                    .padding(.vertical, 8)
                }
            } else if let failure {
                switch failure {
                case .missing:
                    ContentUnavailableView {
                        Label("No notebook here yet", systemImage: "text.book.closed")
                    } description: {
                        Text("Nothing at \(path).")
                    } actions: {
                        Button("Create \((path as NSString).lastPathComponent)") { Task { await create() } }.buttonStyle(.borderedProminent)
                    }
                case .unreadable(let message):
                    ContentUnavailableView {
                        Label("Could not read this notebook", systemImage: "xmark.circle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Retry") { Task { await read() } }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }

        .task(id: "\(path):\(active):\(signals.notebookRevision[path] ?? 0):\(signals.kernelRevision)") {
            if didFirstRead { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }
            await read()

            if !didFirstRead {
                didFirstRead = true
                await readKernel()
            }
        }
        .onDisappear { flushAll() }

        .environment(\.workspaceImages) { [api, sessionId] path in
            guard let raw = try? await api.sessionFileRaw(sessionId, path: path) else { return nil }
            return UIImage(data: raw.data)
        }

        .toolbar {
            if let cell = selectedCell {
                ToolbarItemGroup(placement: .keyboard) {
                    if cell.type == .code {
                        Button { Task { await run(cell) } } label: { Image(systemName: "play.fill") }
                            .accessibilityLabel("Run")
                        Button { Task { await runAndAdvance(cell) } } label: { Image(systemName: "play.circle") }
                            .accessibilityLabel("Run and advance")
                    }
                    Button { Task { await insert(after: .string(cell.id), type: cell.type == .code ? "code" : "markdown") } } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Insert below")
                    Button { Task { await setType(cell, cell.type == .code ? "markdown" : "code") } } label: {
                        Image(systemName: "arrow.left.arrow.right")
                    }
                    .accessibilityLabel(cell.type == .code ? "Make text" : "Make code")
                    Button { Task { await move(cell, by: -1) } } label: { Image(systemName: "arrow.up") }
                        .accessibilityLabel("Move up")
                    Button { Task { await move(cell, by: 1) } } label: { Image(systemName: "arrow.down") }
                        .accessibilityLabel("Move down")
                    Button(role: .destructive) { Task { await delete(cell) } } label: { Image(systemName: "trash") }
                        .accessibilityLabel("Delete cell")
                    Spacer()
                    Button { endEditing(cell) } label: { Image(systemName: "keyboard.chevron.compact.down") }
                        .accessibilityLabel("Dismiss keyboard")
                }
            }
        }

        .background {
            ZStack {
                Button("") { if let cell = selectedCell { Task { await runAndAdvance(cell) } } }
                    .keyboardShortcut(.return, modifiers: .shift)
                Button("") { if let cell = selectedCell { Task { await run(cell) } } }
                    .keyboardShortcut(.return, modifiers: .command)
            }
            .opacity(0)
            .accessibilityHidden(true)
        }
        .sheet(item: Binding(get: { lightbox.map { LightboxItem(id: $0) } }, set: { lightbox = $0?.id })) { item in
            ImageLightbox(api: api, sessionId: sessionId, hostId: hostId, attachmentId: item.id)
        }
    }

    private struct LightboxItem: Identifiable { let id: EngineID }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "text.book.closed").font(.system(Theme.caption)).foregroundStyle(Theme.textMuted)
            Text(path).font(.system(Theme.caption, design: .monospaced)).foregroundStyle(Theme.textMuted).lineLimit(1).truncationMode(.head)
            Spacer(minLength: 4)

            if !drafts.isEmpty {
                Circle().fill(Theme.accent).frame(width: 6, height: 6)
                    .accessibilityLabel("Saving")
            } else if saved {
                Image(systemName: "checkmark").font(.system(Theme.captionTiny, weight: .bold)).foregroundStyle(Theme.statusEmerald)
                    .accessibilityLabel("Saved")
            }
            KernelPill(state: signals.kernelState ?? kernel)
            Button { Task { await runAll() } } label: {
                Image(systemName: runningAll ? "hourglass" : "play.fill").font(.system(Theme.caption))
            }
            .buttonStyle(.plain).foregroundStyle(Theme.text).disabled(runningAll || notebook == nil)
            .accessibilityLabel("Run all cells")
            if kernel.isLive {
                Button { Task { await act(.interrupt) } } label: { Image(systemName: "stop.fill").font(.system(Theme.caption)) }
                    .buttonStyle(.plain).foregroundStyle(Theme.statusRed).disabled(acting)
                    .accessibilityLabel("Interrupt kernel")
            }
            if kernel != .none {
                Button { Task { await act(.restart) } } label: { Image(systemName: "arrow.clockwise").font(.system(Theme.caption)) }
                    .buttonStyle(.plain).foregroundStyle(Theme.textMuted).disabled(acting)
                    .accessibilityLabel("Restart kernel")
            }
        }
        .padding(.horizontal, 10)
        .scaledHeight(32, relativeTo: .caption)
        .background(Theme.sheet)
        .overlay(alignment: .bottom) { Divider().overlay(Theme.borderSubtle) }
    }

    private func problemBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle").font(.system(Theme.caption)).foregroundStyle(Theme.statusRed)
            Text(message).font(.system(Theme.footnote)).foregroundStyle(Theme.statusRed).lineLimit(3)
            Spacer(minLength: 0)
            if message.range(of: "conflict|changed on disk", options: [.regularExpression, .caseInsensitive]) != nil {
                Button("Re-read") { Task { drafts = [:]; await read() } }.font(.system(Theme.footnote, weight: .medium)).buttonStyle(.plain).foregroundStyle(Theme.text)
            }
            Button { problem = nil } label: { Image(systemName: "xmark").font(.system(Theme.caption)) }.buttonStyle(.plain).foregroundStyle(Theme.textMuted)
        }
        .padding(10)
        .background(Theme.statusRed.opacity(0.08))
    }

    private func staleBanner(_ failure: NotebookReadFailure) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle").font(.system(Theme.caption)).foregroundStyle(Theme.statusAmber)
            Text(failure == .missing ? "This notebook is no longer in the workspace." : { if case .unreadable(let m) = failure { return m } else { return "" } }())
                .font(.system(Theme.footnote)).foregroundStyle(Theme.statusAmber).lineLimit(2)
            Spacer(minLength: 0)
            Button("Retry") { Task { await read() } }.font(.system(Theme.footnote, weight: .medium)).buttonStyle(.plain).foregroundStyle(Theme.text)
        }
        .padding(10)
        .background(Theme.statusAmber.opacity(0.08))
    }

    private func insertBar(after: String) -> some View {
        HStack(spacing: 10) {
            Rectangle().fill(Theme.borderSubtle).frame(height: 1)
            Button("+ Code") { Task { await insert(after: .string(after), type: "code") } }
            Button("+ Text") { Task { await insert(after: .string(after), type: "markdown") } }
            Rectangle().fill(Theme.borderSubtle).frame(height: 1)
        }
        .font(.system(Theme.caption, weight: .medium))
        .foregroundStyle(Theme.accent)
        .buttonStyle(.plain)
        .scaledHeight(32, relativeTo: .caption)
        .padding(.horizontal, 10)
    }

    private var addBar: some View {
        HStack(spacing: 10) {
            Button {
                Task { await insert(after: notebook?.cells.last.map { JSONValue.string($0.id) }, type: "code") }
            } label: {
                Label("Code", systemImage: "plus").frame(minHeight: 36)
            }
            Button {
                Task { await insert(after: notebook?.cells.last.map { JSONValue.string($0.id) }, type: "markdown") }
            } label: {
                Label("Text", systemImage: "plus").frame(minHeight: 36)
            }
            Spacer(minLength: 0)
        }
        .font(.system(Theme.footnote, weight: .medium))
        .buttonStyle(.bordered)
        .tint(Theme.textMuted)
        .padding(.horizontal, 10)
        .padding(.top, 6)
    }

    private func cellView(_ cell: NotebookCell) -> some View {
        HStack(alignment: .top, spacing: 6) {
            VStack(spacing: 2) {
                if cell.type == .code {
                    Button { Task { await run(cell) } } label: {
                        Image(systemName: running.contains(cell.id) ? "hourglass" : "play.fill")
                            .scaledGlyphBox(44, glyph: 14)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.textMuted).disabled(running.contains(cell.id))
                    .accessibilityLabel("Run cell")
                    Text(cell.executionCount.map { "[\($0)]" } ?? "[ ]")
                        .font(.system(Theme.captionTiny, design: .monospaced)).foregroundStyle(Theme.textMuted)
                } else {
                    Image(systemName: "text.alignleft").foregroundStyle(Theme.textMuted)
                        .scaledGlyphBox(44, glyph: 12)
                }
            }
            .frame(width: gutter)
            VStack(alignment: .leading, spacing: 6) {
                if cell.type == .markdown && editing != cell.id {
                    MarkdownText(text: drafts[cell.id] ?? cell.source, source: .notebookCell(path: path))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                        .onTapGesture(count: 2) { editing = cell.id }
                } else if cell.type == .code && editing != cell.id {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HighlightedCode(text: drafts[cell.id] ?? cell.source, language: "python")
                            .padding(6)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.codeBackground, in: RoundedRectangle(cornerRadius: 6))
                    .accessibilityAddTraits(.isButton)
                    .accessibilityHint(selected == cell.id ? "Edit this cell" : "Select this cell")
                } else {
                    TextEditor(text: Binding(get: { drafts[cell.id] ?? cell.source }, set: { edit(cell, $0) }))
                        .font(.system(Theme.footnote, design: .monospaced))
                        .scrollContentBackground(.hidden)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .frame(minHeight: 44)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(6)
                        .background(Theme.codeBackground, in: RoundedRectangle(cornerRadius: 6))
                        .focused($focusedCell, equals: cell.id)
                }

                if let outputs = cell.outputs, !outputs.isEmpty, !collapsedOutputs.contains(cell.id) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(outputs.enumerated()), id: \.offset) { _, output in
                            CellOutputView(output: output, api: api, sessionId: sessionId, onOpenImage: { lightbox = $0 })
                        }
                    }
                    .padding(.leading, 4)
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)

        .background(selected == cell.id ? Theme.accent.opacity(0.05) : .clear)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(selected == cell.id ? Theme.accent : .clear)
                .frame(width: 3)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if selected == cell.id { beginEditing(cell) } else { select(cell) }
        }
        .contextMenu { cellMenu(cell) }
    }

    @ViewBuilder private func cellMenu(_ cell: NotebookCell) -> some View {
        if editing == cell.id {
            Button("Done editing", systemImage: "checkmark") { endEditing(cell) }
        } else {
            Button("Edit", systemImage: "pencil") { beginEditing(cell) }
        }
        if cell.type == .code {
            Button("Run", systemImage: "play.fill") { Task { await run(cell) } }
            Button("Run and advance", systemImage: "play.circle") { Task { await runAndAdvance(cell) } }
        }
        Button("Run all", systemImage: "forward.end.fill") { Task { await runAll() } }
            .disabled(runningAll)
        Divider()

        Button(cell.type == .code ? "Change to Markdown" : "Change to Code", systemImage: "arrow.left.arrow.right") {
            Task { await setType(cell, cell.type == .code ? "markdown" : "code") }
        }
        let type = cell.type == .code ? "code" : "markdown"
        Button("Insert cell above", systemImage: "plus") { Task { await insert(above: cell, type: type) } }
        Button("Insert cell below", systemImage: "plus") { Task { await insert(after: .string(cell.id), type: type) } }
        Button("Move up", systemImage: "arrow.up") { Task { await move(cell, by: -1) } }
        Button("Move down", systemImage: "arrow.down") { Task { await move(cell, by: 1) } }
        Button("Delete cell", systemImage: "trash", role: .destructive) { Task { await delete(cell) } }
        Divider()

        Button("Copy source", systemImage: "doc.on.doc") { UIPasteboard.general.string = drafts[cell.id] ?? cell.source }
        if cell.type == .code, let outputs = cell.outputs, !outputs.isEmpty {
            Divider()
            let hidden = collapsedOutputs.contains(cell.id)
            Button(hidden ? "Expand outputs" : "Collapse outputs", systemImage: hidden ? "chevron.down" : "chevron.up") {
                if hidden { collapsedOutputs.remove(cell.id) } else { collapsedOutputs.insert(cell.id) }
            }

            Button("Clear outputs", systemImage: "eraser") { Task { await clearOutputs(cell) } }
        }
    }

    private var selectedCell: NotebookCell? {
        guard let selected else { return nil }
        return notebook?.cells.first { $0.id == selected }
    }

    private func select(_ cell: NotebookCell) {
        if let editing, editing != cell.id, let previous = notebook?.cells.first(where: { $0.id == editing }) {
            endEditing(previous)
        }
        selected = cell.id
    }

    private func beginEditing(_ cell: NotebookCell) {
        selected = cell.id
        editing = cell.id
        focusedCell = cell.id
    }

    private func endEditing(_ cell: NotebookCell) {
        if editing == cell.id { editing = nil }
        focusedCell = nil
        flush(cell.id)
    }

    private func runAndAdvance(_ cell: NotebookCell) async {
        await run(cell)
        editing = nil
        focusedCell = nil
        if let next = notebookNext(cell.id, in: (notebook?.cells ?? []).map(\.id)) { selected = next }
    }

    private func move(_ cell: NotebookCell, by offset: Int) async {
        guard let cells = notebook?.cells,
              let to = notebookMove(cell.id, by: offset, in: cells.map(\.id)) else { return }
        let edit: [String: JSONValue] = [
            "kind": .string("move"), "cellId": .string(cell.id), "to": .number(Double(to)),
        ]
        do {
            notebook = try await api.notebookEdit(sessionId, path: path, edit: .object(edit))
            problem = nil
        } catch {
            problem = describe(error)
        }
    }

    private func read() async {
        do {
            notebook = try await api.notebookRead(sessionId, path: path)
            failure = nil

            drafts = drafts.filter { id, _ in notebook?.cells.contains { $0.id == id } == true }
        } catch {
            failure = classifyNotebookRead(error)
        }
    }

    private func readKernel() async {
        kernel = (try? await api.kernel(sessionId))?.state ?? .none
    }

    private func edit(_ cell: NotebookCell, _ text: String) {
        drafts[cell.id] = text
        saved = false
        saveTasks[cell.id]?.cancel()
        saveTasks[cell.id] = Task {
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            await save(cell.id)
        }
    }

    private func save(_ cellId: String) async {
        guard let text = drafts[cellId] else { return }
        do {
            let fresh = try await api.notebookEdit(sessionId, path: path, edit: .object(["kind": .string("set"), "cellId": .string(cellId), "source": .string(text)]))
            notebook = fresh
            if drafts[cellId] == text { drafts[cellId] = nil }
            if drafts.isEmpty { saved = true }
            problem = nil
        } catch {
            problem = describe(error)
        }
    }

    private func flush(_ cellId: String) {
        saveTasks[cellId]?.cancel()
        Task { await save(cellId) }
    }

    private func flushAll() {
        for id in drafts.keys { flush(id) }
    }

    private func insert(after: JSONValue?, type: String) async {
        var edit: [String: JSONValue] = ["kind": .string("insert"), "source": .string(""), "cellType": .string(type)]
        if let after { edit["after"] = after }
        do {
            notebook = try await api.notebookEdit(sessionId, path: path, edit: .object(edit))
        } catch {
            problem = describe(error)
        }
    }

    private func insert(above cell: NotebookCell, type: String) async {
        let ids = (notebook?.cells ?? []).map(\.id)
        guard let index = ids.firstIndex(of: cell.id) else { return }
        await insert(after: index == 0 ? .number(-1) : .string(ids[index - 1]), type: type)
    }

    private func clearOutputs(_ cell: NotebookCell) async {
        do {
            notebook = try await api.notebookEdit(
                sessionId, path: path,
                edit: .object(["kind": .string("clearOutputs"), "cellId": .string(cell.id)])
            )
            problem = nil
        } catch {
            problem = describe(error)
        }
    }

    private func setType(_ cell: NotebookCell, _ type: String) async {
        do {
            notebook = try await api.notebookEdit(sessionId, path: path, edit: .object(["kind": .string("set"), "cellId": .string(cell.id), "cellType": .string(type)]))
        } catch {
            problem = describe(error)
        }
    }

    private func delete(_ cell: NotebookCell) async {
        do {
            notebook = try await api.notebookEdit(sessionId, path: path, edit: .object(["kind": .string("delete"), "cellId": .string(cell.id)]))
            drafts[cell.id] = nil
        } catch {
            problem = describe(error)
        }
    }

    private func create() async {
        do {
            notebook = try await api.notebookEdit(sessionId, path: path, edit: .object(["kind": .string("create")]))
            failure = nil
        } catch {
            problem = describe(error)
        }
    }

    private func run(_ cell: NotebookCell) async {
        for id in drafts.keys { saveTasks[id]?.cancel(); await save(id) }
        running.insert(cell.id)
        defer { running.remove(cell.id) }
        do {
            let result = try await api.notebookRun(sessionId, path: path, cellId: cell.id)
            notebook = result.notebook
            problem = nil
        } catch {
            problem = describe(error)
        }
        await read()
        await readKernel()
    }

    private func runAll() async {
        for id in drafts.keys { saveTasks[id]?.cancel(); await save(id) }
        runningAll = true
        defer { runningAll = false }
        do {
            let result = try await api.notebookRun(sessionId, path: path, cellId: nil, all: true)
            notebook = result.notebook
            problem = nil
        } catch {
            problem = describe(error)
        }
        await read()
        await readKernel()
    }

    private enum KernelAction { case interrupt, restart }

    private func act(_ action: KernelAction) async {
        acting = true
        defer { acting = false }
        do {
            switch action {
            case .interrupt: try await api.kernelInterrupt(sessionId)
            case .restart: try await api.kernelRestart(sessionId)
            }
        } catch {
            problem = describe(error)
        }
        await readKernel()
    }
}

struct ReadOnlyNotebookView: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let hostId: HostID?
    let path: String
    let active: Bool

    @State private var notebook: NotebookRead?
    @State private var bytes: Int?
    @State private var error: String?
    @State private var lightbox: EngineID?

    var body: some View {
        VStack(spacing: 0) {
            FileAddressRow(path: path, detail: detail)
            if notebook != nil { kernelNote }
            if let notebook {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(notebook.cells) { cell in cellView(cell) }
                    }
                    .padding(.vertical, 8)
                }
            } else if let error {
                ContentUnavailableView("Could not read this notebook", systemImage: "xmark.circle", description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: "\(path):\(active)") { await read() }
        .environment(\.workspaceImages) { [api, sessionId] path in
            guard let raw = try? await api.sessionFileRaw(sessionId, path: path) else { return nil }
            return UIImage(data: raw.data)
        }
        .sheet(item: Binding(get: { lightbox.map { ReadOnlyLightboxItem(id: $0) } }, set: { lightbox = $0?.id })) { item in
            ImageLightbox(api: api, sessionId: sessionId, hostId: hostId, attachmentId: item.id)
        }
    }

    private struct ReadOnlyLightboxItem: Identifiable { let id: EngineID }

    private var detail: String? {
        guard let notebook else { return bytes.map(humanBytes) }
        let count = notebook.cells.count
        return "\(count) cell\(count == 1 ? "" : "s")\(bytes.map { " · \(humanBytes($0))" } ?? "")"
    }

    private var kernelNote: some View {
        HStack(spacing: 8) {
            Image(systemName: "eye").font(.system(Theme.caption)).foregroundStyle(Theme.textMuted)
            Text("Read-only — running cells needs Data Science turned on for this project, on the Mac.")
                .font(.system(Theme.caption))
                .foregroundStyle(Theme.textMuted)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Theme.subtle.opacity(0.5))
        .overlay(alignment: .bottom) { Divider().overlay(Theme.borderSubtle) }
    }

    private func cellView(_ cell: NotebookCell) -> some View {
        HStack(alignment: .top, spacing: 6) {
            VStack(spacing: 2) {
                switch cell.type {
                case .code:
                    Text(cell.executionCount.map { "[\($0)]" } ?? "[ ]")
                        .font(.system(Theme.captionTiny, design: .monospaced)).foregroundStyle(Theme.textMuted)
                case .markdown:
                    Image(systemName: "text.alignleft").font(.system(Theme.footnote)).foregroundStyle(Theme.textMuted)
                case .raw, .unknown:
                    Image(systemName: "doc.plaintext").font(.system(Theme.footnote)).foregroundStyle(Theme.textMuted)
                }
            }
            .frame(width: 44, alignment: .top)
            .padding(.top, 4)
            VStack(alignment: .leading, spacing: 6) {
                if cell.type == .markdown {
                    MarkdownText(text: cell.source, source: .notebookCell(path: path))
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HighlightedCode(text: cell.source, language: cell.type == .code ? "python" : nil)
                            .padding(6)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.codeBackground, in: RoundedRectangle(cornerRadius: 6))
                }
                if let outputs = cell.outputs, !outputs.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(outputs.enumerated()), id: \.offset) { _, output in
                            CellOutputView(output: output, api: api, sessionId: sessionId, onOpenImage: { lightbox = $0 })
                        }
                    }
                    .padding(.leading, 4)
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }

    private func read() async {
        do {
            let raw = try await api.sessionFileRaw(sessionId, path: path)
            bytes = raw.data.count

            guard let parsed = parseNotebookFile(raw.data, path: path, sha256: "") else {
                error = "This file is not nbformat JSON — there are no cells in it to show."
                return
            }
            notebook = parsed
            error = nil
        } catch {
            self.error = describe(error)
        }
    }
}

enum NotebookReadFailure: Equatable {
    case missing
    case unreadable(String)
}

func classifyNotebookRead(_ error: Error) -> NotebookReadFailure {
    guard let apiError = error as? EngineAPIError, case .engine(let code, let message, _) = apiError else {
        return .unreadable(describe(error))
    }
    let missingFile = message.range(of: "no such file in this workspace", options: .caseInsensitive) != nil
    let notTheFile = message.range(of: "\\b(method|plugin|endpoint|has no|route)\\b", options: [.regularExpression, .caseInsensitive]) != nil
    if code == "not_found", missingFile, !notTheFile { return .missing }

    return .unreadable(message)
}

struct KernelPill: View {
    let state: KernelState

    var body: some View {
        Text(state == .none ? "no kernel" : state.rawValue)
            .font(.system(Theme.captionTiny, weight: .semibold))
            .textCase(.uppercase)
            .foregroundStyle(tone)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(tone.opacity(0.12), in: Capsule())
            .accessibilityLabel("Kernel \(state.rawValue)")
    }

    private var tone: Color {
        switch state {
        case .idle: Theme.statusEmerald
        case .busy: Theme.accent
        case .starting, .restarting: Theme.statusAmber
        case .dead: Theme.statusRed
        case .none, .unknown: Theme.textMuted
        }
    }
}

struct ImageLightbox: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let hostId: HostID?
    let attachmentId: EngineID

    @State private var image: UIImage?
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let image {
                    ScrollView([.vertical, .horizontal]) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .scaleEffect(scale)
                            .frame(width: image.size.width * scale, height: image.size.height * scale)
                    }
                    .gesture(MagnificationGesture()
                        .onChanged { value in scale = max(0.5, min(6, lastScale * value)) }
                        .onEnded { _ in lastScale = scale })
                    .background(Color.white)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Figure")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { image = await AttachmentImageCache.shared.image(host: hostId, session: sessionId, attachmentId: attachmentId, api: api) }
        }
    }
}

func notebookNext(_ id: String, in ids: [String]) -> String? {
    guard let index = ids.firstIndex(of: id), ids.indices.contains(index + 1) else { return nil }
    return ids[index + 1]
}

func notebookMove(_ id: String, by offset: Int, in ids: [String]) -> Int? {
    guard offset != 0, let index = ids.firstIndex(of: id) else { return nil }
    let target = index + offset
    guard ids.indices.contains(target) else { return nil }
    return target
}
