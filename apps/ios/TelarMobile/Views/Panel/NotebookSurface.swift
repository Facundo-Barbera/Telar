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
    @State private var outputsHidden: Set<String> = []

    var body: some View {
        VStack(spacing: 0) {
            header
            if let problem { problemBanner(problem) }
            if let notebook {
                if let failure { staleBanner(failure) }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        insertBar(after: nil)
                        ForEach(notebook.cells) { cell in
                            cellView(cell)
                            insertBar(after: cell.id)
                        }
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
        .task(id: "\(path):\(active)") {
            await read()
            await readKernel()
        }
        .onDisappear { flushAll() }
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
            KernelPill(state: kernel)
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
        HStack(spacing: 6) {
            Spacer()
            Button("+ code") { Task { await insert(after: after, type: "code") } }
            Button("+ text") { Task { await insert(after: after, type: "markdown") } }
            Spacer()
        }
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(Theme.textTertiary)
        .buttonStyle(.plain)
        .frame(height: 16)
        .opacity(0.7)
    }

    private func cellView(_ cell: NotebookCell) -> some View {
        HStack(alignment: .top, spacing: 6) {
            VStack(spacing: 4) {
                if cell.type == .code {
                    Button { Task { await run(cell) } } label: {
                        Image(systemName: running.contains(cell.id) ? "hourglass" : "play").font(.system(size: 11))
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.textMuted).disabled(running.contains(cell.id))
                    .accessibilityLabel("Run cell")
                    Text(cell.executionCount.map { "[\($0)]" } ?? "[ ]").font(.system(size: 9, design: .monospaced)).foregroundStyle(Theme.textTertiary)
                } else {
                    Image(systemName: "text.alignleft").font(.system(size: 10)).foregroundStyle(Theme.textTertiary).padding(.top, 4)
                }
            }
            .frame(width: 34)
            VStack(alignment: .leading, spacing: 6) {
                if cell.type == .markdown && editing != cell.id {
                    MarkdownText(text: drafts[cell.id] ?? cell.source)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                        .onTapGesture(count: 2) { editing = cell.id }
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
                }
                if let outputs = cell.outputs, !outputs.isEmpty, !outputsHidden.contains(cell.id) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(outputs.enumerated()), id: \.offset) { _, output in
                            CellOutputView(output: output, api: api, sessionId: sessionId, onOpenImage: { lightbox = $0 })
                        }
                    }
                    .padding(.leading, 4)
                }
            }
            Menu {
                if cell.type == .markdown { Button("Edit text", systemImage: "pencil") { editing = cell.id } }
                if cell.type == .markdown && editing == cell.id { Button("Done editing", systemImage: "checkmark") { editing = nil; flush(cell.id) } }
                Button(cell.type == .code ? "Make text" : "Make code", systemImage: "arrow.left.arrow.right") {
                    Task { await setType(cell, cell.type == .code ? "markdown" : "code") }
                }
                if let outputs = cell.outputs, !outputs.isEmpty {
                    Button(outputsHidden.contains(cell.id) ? "Show outputs" : "Hide outputs", systemImage: "eye") {
                        if outputsHidden.contains(cell.id) { outputsHidden.remove(cell.id) } else { outputsHidden.insert(cell.id) }
                    }
                }
                Button("Delete cell", systemImage: "trash", role: .destructive) { Task { await delete(cell) } }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 11)).foregroundStyle(Theme.textTertiary).frame(width: 24, height: 24)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
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
