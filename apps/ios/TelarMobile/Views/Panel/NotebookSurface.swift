import SwiftUI

/// A notebook as cells, over the session's kernel — the desktop's
/// `NotebookSurface`. Every verb is a POST to the same `ds/` door the
/// agent's tools use, so a cell run here and one the model ran land in the
/// same kernel and write the same file.
///
/// FOUR STATES THAT ARE NOT INTERCHANGEABLE, and the one that matters most:
/// `classifyNotebookRead` treats a 404 as "no such notebook" ONLY when the
/// engine's own sentence says the file is missing. A 404 from a missing
/// plugin route used to render "No notebook here yet" with a Create button
/// over somebody's existing file.
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
    /// THE SELECTED CELL — JupyterLab's command mode, sized for touch. Tap
    /// selects, tap the selected one edits. Without it every tap landed a
    /// caret, and a notebook you could not scroll without typing in it.
    @State private var selected: String?
    @FocusState private var focusedCell: String?
    /// Set the moment a draft lands, cleared when the last one flushes: the
    /// header's dot and tick.
    @State private var saved = false
    @Environment(\.kernelSignals) private var signals
    /// The one-shot kernel read happens on the way in only; after that the
    /// events are the truth. It also gates the debounce, so opening a notebook
    /// is immediate and only later bursts are coalesced.
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
                            // BETWEEN CELLS ONLY WHEN ONE IS SELECTED. A row of
                            // buttons between every pair is noise in a notebook
                            // you are reading; it is exactly what you want in
                            // the one you are editing.
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
        // THE KERNEL SPEAKING IS THE SIGNAL, not a turn settling. A cell the
        // agent runs mid-turn used to change nothing here until the whole turn
        // finished — which is what "tables don't render until you refresh the
        // kernel" was. This notebook follows ITS OWN producer, so another
        // notebook's cell does not reload it.
        .task(id: "\(path):\(active):\(signals.notebookRevision[path] ?? 0):\(signals.kernelRevision)") {
            // COALESCED. A cell emitting six outputs bumps the revision six
            // times in a second; restarting the task cancels this sleep, so
            // the burst costs one read rather than six.
            if didFirstRead { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }
            await read()
            // Only on the way in: after that the kernel's own events are the
            // truth, and asking again would race them.
            if !didFirstRead {
                didFirstRead = true
                await readKernel()
            }
        }
        .onDisappear { flushAll() }
        // A markdown cell's `<img src="fig.png">` points into the checkout,
        // and a Markdown image provider has no way to be handed an API — so
        // the read is put where it can reach one.
        .environment(\.workspaceImages) { [api, sessionId] path in
            guard let raw = try? await api.sessionFileRaw(sessionId, path: path) else { return nil }
            return UIImage(data: raw.data)
        }
        // THE CELL TOOLBAR RIDES THE KEYBOARD. Everything you do to a cell
        // while typing in it was behind an ellipsis menu you had to dismiss
        // the keyboard to reach.
        .toolbar {
            if let cell = selectedCell {
                ToolbarItemGroup(placement: .keyboard) {
                    if cell.type == .code {
                        Button { Task { await run(cell) } } label: { Image(systemName: "play.fill") }
                            .accessibilityLabel("Run")
                        Button { Task { await runAndAdvance(cell) } } label: { Image(systemName: "play.circle") }
                            .accessibilityLabel("Run and advance")
                    }
                    Button { Task { await insert(after: cell.id, type: cell.type == .code ? "code" : "markdown") } } label: {
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
        // A HARDWARE KEYBOARD RUNS CELLS, the two chords every notebook uses.
        // Zero-sized buttons rather than `onKeyPress`, so they are shortcuts
        // and not controls in the layout.
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

    // MARK: header

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "text.book.closed").font(.system(size: 11)).foregroundStyle(Theme.textMuted)
            Text(path).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.textMuted2).lineLimit(1).truncationMode(.head)
            Spacer(minLength: 4)
            // UNSAVED WORK IS VISIBLE. A debounced autosave with no sign of
            // itself is indistinguishable from one that is broken.
            if !drafts.isEmpty {
                Circle().fill(Theme.accent).frame(width: 6, height: 6)
                    .accessibilityLabel("Saving")
            } else if saved {
                Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.statusEmerald)
                    .accessibilityLabel("Saved")
            }
            KernelPill(state: signals.kernelState ?? kernel)
            Button { Task { await runAll() } } label: {
                Image(systemName: runningAll ? "hourglass" : "play.fill").font(.system(size: 11))
            }
            .buttonStyle(.plain).foregroundStyle(Theme.text).disabled(runningAll || notebook == nil)
            .accessibilityLabel("Run all cells")
            if kernel.isLive {
                Button { Task { await act(.interrupt) } } label: { Image(systemName: "stop.fill").font(.system(size: 11)) }
                    .buttonStyle(.plain).foregroundStyle(Theme.statusRed).disabled(acting)
                    .accessibilityLabel("Interrupt kernel")
            }
            if kernel != .none {
                Button { Task { await act(.restart) } } label: { Image(systemName: "arrow.clockwise").font(.system(size: 11)) }
                    .buttonStyle(.plain).foregroundStyle(Theme.textMuted).disabled(acting)
                    .accessibilityLabel("Restart kernel")
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 32)
        .background(Theme.sheet)
        .overlay(alignment: .bottom) { Divider().overlay(Theme.borderSubtle) }
    }

    private func problemBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 11)).foregroundStyle(Theme.statusRed)
            Text(message).font(.system(size: 12)).foregroundStyle(Theme.statusRed).lineLimit(3)
            Spacer(minLength: 0)
            if message.range(of: "conflict|changed on disk", options: [.regularExpression, .caseInsensitive]) != nil {
                Button("Re-read") { Task { drafts = [:]; await read() } }.font(.system(size: 12, weight: .medium)).buttonStyle(.plain).foregroundStyle(Theme.text)
            }
            Button { problem = nil } label: { Image(systemName: "xmark").font(.system(size: 10)) }.buttonStyle(.plain).foregroundStyle(Theme.textMuted)
        }
        .padding(10)
        .background(Theme.statusRed.opacity(0.08))
    }

    private func staleBanner(_ failure: NotebookReadFailure) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 11)).foregroundStyle(Theme.statusAmber)
            Text(failure == .missing ? "This notebook is no longer in the workspace." : { if case .unreadable(let m) = failure { return m } else { return "" } }())
                .font(.system(size: 12)).foregroundStyle(Theme.statusAmber).lineLimit(2)
            Spacer(minLength: 0)
            Button("Retry") { Task { await read() } }.font(.system(size: 12, weight: .medium)).buttonStyle(.plain).foregroundStyle(Theme.text)
        }
        .padding(10)
        .background(Theme.statusAmber.opacity(0.08))
    }

    // MARK: cells

    private func insertBar(after: String?) -> some View {
        HStack(spacing: 10) {
            Rectangle().fill(Theme.borderSubtle).frame(height: 1)
            Button("+ Code") { Task { await insert(after: after, type: "code") } }
            Button("+ Text") { Task { await insert(after: after, type: "markdown") } }
            Rectangle().fill(Theme.borderSubtle).frame(height: 1)
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(Theme.accent)
        .buttonStyle(.plain)
        .frame(height: 32)
        .padding(.horizontal, 10)
    }

    /// ALWAYS THERE, at the end. Adding the first cell to an empty notebook,
    /// or one more at the bottom, should never require selecting something
    /// first.
    private var addBar: some View {
        HStack(spacing: 10) {
            Button {
                Task { await insert(after: notebook?.cells.last?.id, type: "code") }
            } label: {
                Label("Code", systemImage: "plus").frame(minHeight: 36)
            }
            Button {
                Task { await insert(after: notebook?.cells.last?.id, type: "markdown") }
            } label: {
                Label("Text", systemImage: "plus").frame(minHeight: 36)
            }
            Spacer(minLength: 0)
        }
        .font(.system(size: 12, weight: .medium))
        .buttonStyle(.bordered)
        .tint(Theme.textMuted)
        .padding(.horizontal, 10)
        .padding(.top, 6)
    }

    private func cellView(_ cell: NotebookCell) -> some View {
        HStack(alignment: .top, spacing: 6) {
            VStack(spacing: 2) {
                if cell.type == .code {
                    // A 44pt TARGET. An 11pt glyph is a dart-throw on a
                    // touchscreen, and running a cell is the thing you do most.
                    Button { Task { await run(cell) } } label: {
                        Image(systemName: running.contains(cell.id) ? "hourglass" : "play.fill")
                            .font(.system(size: 14))
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.textMuted).disabled(running.contains(cell.id))
                    .accessibilityLabel("Run cell")
                    Text(cell.executionCount.map { "[\($0)]" } ?? "[ ]")
                        .font(.system(size: 9, design: .monospaced)).foregroundStyle(Theme.textTertiary)
                } else {
                    Image(systemName: "text.alignleft").font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                        .frame(width: 44, height: 44)
                }
            }
            .frame(width: 44)
            VStack(alignment: .leading, spacing: 6) {
                if cell.type == .markdown && editing != cell.id {
                    MarkdownText(text: drafts[cell.id] ?? cell.source, source: .notebookCell(path: path))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                        .onTapGesture(count: 2) { editing = cell.id }
                } else if cell.type == .code && editing != cell.id {
                    // A CELL AT REST IS READ, NOT TYPED IN. A `TextEditor` per
                    // cell means no colour and a caret wherever you touch; the
                    // editor now appears when you ask for it, and until then
                    // the code is coloured like every other code in the app.
                    HighlightedCode(text: drafts[cell.id] ?? cell.source, language: "python")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(6)
                        .background(Theme.codeBackground, in: RoundedRectangle(cornerRadius: 6))
                        .accessibilityAddTraits(.isButton)
                        .accessibilityHint(selected == cell.id ? "Edit this cell" : "Select this cell")
                } else {
                    TextEditor(text: Binding(get: { drafts[cell.id] ?? cell.source }, set: { edit(cell, $0) }))
                        .font(.system(size: 12, design: .monospaced))
                        .scrollContentBackground(.hidden)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .frame(minHeight: 44)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(6)
                        .background(Theme.codeBackground, in: RoundedRectangle(cornerRadius: 6))
                        .focused($focusedCell, equals: cell.id)
                }
                // Outputs are always shown now: long ones CLAMP with their own
                // expander rather than being hidden wholesale from a menu.
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
        // THE SELECTED CELL IS VISIBLE. A ring and a wash, the way JupyterLab
        // marks command mode — without it "tap again to edit" is a rule with
        // nothing on screen to hang it on.
        .background(selected == cell.id ? Theme.accent.opacity(0.05) : .clear)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(selected == cell.id ? Theme.accent : .clear)
                .frame(width: 3)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            // Tap selects; tap the selected one edits. Markdown keeps its
            // double tap as well, which is the gesture people already know.
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
        Button(cell.type == .code ? "Make text" : "Make code", systemImage: "arrow.left.arrow.right") {
            Task { await setType(cell, cell.type == .code ? "markdown" : "code") }
        }
        Button("Insert below", systemImage: "plus") { Task { await insert(after: cell.id, type: cell.type == .code ? "code" : "markdown") } }
        Button("Move up", systemImage: "arrow.up") { Task { await move(cell, by: -1) } }
        Button("Move down", systemImage: "arrow.down") { Task { await move(cell, by: 1) } }
        Button("Delete cell", systemImage: "trash", role: .destructive) { Task { await delete(cell) } }
    }

    // MARK: selection

    private var selectedCell: NotebookCell? {
        guard let selected else { return nil }
        return notebook?.cells.first { $0.id == selected }
    }

    private func select(_ cell: NotebookCell) {
        // Selecting away from a cell being edited ends that edit, so a draft
        // is never left open behind a selection somewhere else.
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

    /// Run, then select the next cell — Shift-Return's half that is not the
    /// run. At the end it stays put rather than wrapping, which is what
    /// JupyterLab does when there is nothing after.
    private func runAndAdvance(_ cell: NotebookCell) async {
        await run(cell)
        editing = nil
        focusedCell = nil
        if let next = notebookNext(cell.id, in: (notebook?.cells ?? []).map(\.id)) { selected = next }
    }

    /// MOVE IS THE ENGINE'S JOB. Doing it here as delete-then-insert would
    /// throw away the cell's outputs and its execution count, which is the
    /// history of what actually ran.
    ///
    /// `to` is the ABSOLUTE index the cell occupies afterwards, which is the
    /// shape the engine's edit takes. Out of range is refused there with its
    /// own sentence and the file left untouched; this does not send one, so
    /// the banner stays for things the reader can do something about.
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

    // MARK: reads

    private func read() async {
        do {
            notebook = try await api.notebookRead(sessionId, path: path)
            failure = nil
            // Adopt any draft whose cell still exists; what is on screen wins.
            drafts = drafts.filter { id, _ in notebook?.cells.contains { $0.id == id } == true }
        } catch {
            failure = classifyNotebookRead(error)
        }
    }

    private func readKernel() async {
        kernel = (try? await api.kernel(sessionId))?.state ?? .none
    }

    // MARK: edits — debounced, flushed on disappear and before a run

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

    private func insert(after: String?, type: String) async {
        var edit: [String: JSONValue] = ["kind": .string("insert"), "source": .string(""), "cellType": .string(type)]
        if let after { edit["after"] = .string(after) }
        do {
            notebook = try await api.notebookEdit(sessionId, path: path, edit: .object(edit))
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

    // MARK: runs — pending drafts land first, so the kernel runs what is on screen

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

enum NotebookReadFailure: Equatable {
    case missing
    case unreadable(String)
}

/// THE ALLOWLIST, NOT A DENYLIST. `missing` only when the engine said the
/// FILE is missing, in its own words, and did not say the door is.
func classifyNotebookRead(_ error: Error) -> NotebookReadFailure {
    guard let apiError = error as? EngineAPIError, case .engine(let code, let message, _) = apiError else {
        return .unreadable(describe(error))
    }
    let missingFile = message.range(of: "no such file in this workspace", options: .caseInsensitive) != nil
    let notTheFile = message.range(of: "\\b(method|plugin|endpoint|has no|route)\\b", options: [.regularExpression, .caseInsensitive]) != nil
    if code == "not_found", missingFile, !notTheFile { return .missing }
    // The engine's OWN sentence, not the generic "no longer exists": which
    // door refused is the whole point of showing it.
    return .unreadable(message)
}

struct KernelPill: View {
    let state: KernelState

    var body: some View {
        Text(state == .none ? "no kernel" : state.rawValue)
            .font(.system(size: 9, weight: .semibold))
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

/// A figure, large: pinch to zoom, drag to pan, over the attachment bytes.
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

/// WHERE SHIFT-RETURN LANDS. The cell after this one, or nowhere: at the end
/// it stays put rather than wrapping to the top, which is what JupyterLab
/// does and what anyone running a notebook top to bottom expects.
func notebookNext(_ id: String, in ids: [String]) -> String? {
    guard let index = ids.firstIndex(of: id), ids.indices.contains(index + 1) else { return nil }
    return ids[index + 1]
}

/// WHERE A MOVED CELL ENDS UP — the ABSOLUTE index it occupies afterwards,
/// which is what the engine's `move` edit takes. Up is one less, down is one
/// more, and that is the whole rule; the earlier "put it after that one"
/// phrasing needed a special case for reaching the front and this does not.
///
/// Off either end returns nil and nothing is sent: the engine would refuse it
/// ("move target N is out of range") and leave the file alone, but a refusal
/// the reader cannot act on does not belong in the problem banner. Moving
/// nowhere is nil for the same reason — it is a byte-identical no-op there.
func notebookMove(_ id: String, by offset: Int, in ids: [String]) -> Int? {
    guard offset != 0, let index = ids.firstIndex(of: id) else { return nil }
    let target = index + offset
    guard ids.indices.contains(target) else { return nil }
    return target
}
