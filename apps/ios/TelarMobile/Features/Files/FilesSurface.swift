import SwiftUI

struct FilesSurface: View {
    let api: any PanelAPI
    let sessionId: EngineID
    let hostId: HostID?
    let active: Bool
    let panel: PanelModel

    @State private var listing: WorkspaceListing?
    @State private var statuses: [String: String] = [:]
    @State private var error: String?
    @State private var query = ""
    @State private var expanded: Set<String> = []
    @State private var searched = false
    @State private var saving: [String: SaveState] = [:]
    @State private var revealing: String?
    @State private var width: CGFloat = 0
    @ScaledMetric(relativeTo: .caption2) private var chevronColumn: CGFloat = 10

    enum SaveState { case saving, problem }

    private var sideBySide: Bool { width >= 560 }

    private var tree: [FileTreeNode] { buildFileTree(listing?.files ?? []) }

    var body: some View {
        VStack(spacing: 0) {
            if !panel.editor.files.isEmpty { fileStrip }
            if sideBySide {
                HStack(spacing: 0) {
                    if panel.editor.treeShown {
                        treeColumn.frame(width: 220)
                        Divider().overlay(Theme.borderSubtle)
                    }
                    body_
                }
            } else if panel.editor.treeShown || panel.editor.active == nil {
                treeColumn
            } else {
                body_
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onChange(of: panel.editor.activePath) { if !sideBySide { panel.setTreeShown(false) } }
        .task(id: "\(sessionId):\(active)") { await load() }
    }

    private var fileStrip: some View {
        HStack(spacing: 2) {
            Button {
                panel.setTreeShown(!panel.editor.treeShown)
            } label: {
                Image(systemName: panel.editor.treeShown ? "sidebar.left" : "sidebar.leading")
                    .foregroundStyle(Theme.textMuted)
                    .scaledGlyphBox(28, glyph: 12)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(panel.editor.treeShown ? "Hide tree" : "Show tree")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(panel.editor.files) { file in
                        let isActive = file.path == panel.editor.activePath
                        HStack(spacing: 4) {
                            Text((file.path as NSString).lastPathComponent)
                                .font(.system(Theme.footnote, weight: isActive ? .medium : .regular))
                                .italic(!file.pinned)
                                .foregroundStyle(isActive ? Theme.text : Theme.textMuted)
                                .lineLimit(1)
                            if let state = saving[file.path] {
                                Circle().fill(state == .saving ? Theme.accent : Theme.statusRed).frame(width: 6, height: 6)
                            } else {
                                Button {
                                    panel.closeFile(file.path)
                                } label: {
                                    Image(systemName: "xmark").font(.system(Theme.captionTiny, weight: .semibold)).foregroundStyle(Theme.textMuted)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Close \((file.path as NSString).lastPathComponent)")
                            }
                        }
                        .padding(.horizontal, 8)
                        .scaledHeight(26, relativeTo: .footnote)
                        .background(isActive ? Theme.subtleStrong : .clear, in: RoundedRectangle(cornerRadius: 6))
                        .contentShape(Rectangle())
                        .onTapGesture { panel.activateFile(file.path) }
                        .onTapGesture(count: 2) { panel.pinFile(file.path) }
                        .contextMenu { chipMenu(file) }
                    }
                }
                .padding(.horizontal, 4)
            }
        }
        .padding(.horizontal, 4)
        .scaledHeight(34, relativeTo: .footnote)
        .background(Theme.sheet)
        .overlay(alignment: .bottom) { Divider().overlay(Theme.borderSubtle) }
    }

    @ViewBuilder private func chipMenu(_ file: OpenFile) -> some View {
        Button("Close", systemImage: "xmark") { panel.closeFile(file.path) }
        Button("Close others") { panel.closeOtherFiles(file.path) }
        Button("Close to the right") { panel.closeFilesToTheRight(file.path) }
        Button("Close all") { panel.closeAllFiles() }
        Divider()
        if !file.pinned { Button("Pin", systemImage: "pin") { panel.pinFile(file.path) } }
        Button("Reveal in file tree", systemImage: "sidebar.left") { reveal(file.path) }
        if let absolute = workspaceFilePath(listing?.workspacePath, file.path) {
            Divider()
            Button("Copy path", systemImage: "doc.on.doc") { UIPasteboard.general.string = absolute }
        }
    }

    private func reveal(_ path: String) {
        query = ""
        expanded.formUnion(ancestorsOf([path]))
        panel.setTreeShown(true)
        panel.activateFile(path)
        revealing = path
    }

    private var treeColumn: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(Theme.caption)).foregroundStyle(Theme.textMuted)
                TextField("Search files", text: $query)
                    .font(.system(Theme.footnote))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onChange(of: query) { _, next in
                        if !next.isEmpty && !searched { searched = true }
                        if next.isEmpty { searched = false }
                    }
                Button { Task { await load() } } label: {
                    Image(systemName: "arrow.clockwise").font(.system(Theme.caption)).foregroundStyle(Theme.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Refresh files")
            }
            .padding(.horizontal, 10)
            .scaledHeight(32, relativeTo: .footnote)
            .contentShape(Rectangle())
            .contextMenu {
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
                Button("Collapse all", systemImage: "arrow.down.right.and.arrow.up.left") { expanded = [] }
            }
            Divider().overlay(Theme.borderSubtle)
            if let listing {
                let (matches, dropped) = matchFiles(listing.files, query: query)
                let nodes = query.isEmpty ? tree : buildFileTree(matches)
                let open = query.isEmpty ? expanded : Set(directoryPaths(nodes))
                let rows = flattenTree(nodes, expanded: open)
                if rows.isEmpty {
                    ContentUnavailableView(
                        query.isEmpty ? "This checkout is empty" : "Nothing matches",
                        systemImage: "folder",
                        description: Text(query.isEmpty ? "git lists no files here." : "No path in this checkout contains \"\(query)\".")
                    )
                } else {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(rows) { row in treeRow(row, open: open) }
                            }
                            .padding(.vertical, 4)
                        }
                        .task(id: revealing) {
                            guard let target = revealing else { return }
                            try? await Task.sleep(for: .milliseconds(60))
                            guard !Task.isCancelled else { return }
                            withAnimation { proxy.scrollTo(target, anchor: .center) }
                            revealing = nil
                        }
                    }
                    foot(listing, dropped: dropped)
                }
            } else if let error {
                ContentUnavailableView("Could not read the checkout", systemImage: "xmark.circle", description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.sheet)
    }

    private func treeRow(_ row: FileTreeRow, open: Set<String>) -> some View {
        let node = row.node
        let isOpen = open.contains(node.path)
        let status = node.isDirectory ? nil : statuses[node.path]
        let dirty = node.isDirectory && statuses.keys.contains { $0.hasPrefix(node.path + "/") }
        return Button {
            if node.isDirectory { toggle(node.path) } else { openFromTree(node.path, pin: false) }
        } label: {
            HStack(spacing: 5) {
                if node.isDirectory {
                    Image(systemName: "chevron.right")
                        .font(.system(Theme.captionTiny, weight: .semibold))
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                        .foregroundStyle(Theme.textMuted.opacity(0.7))
                        .frame(width: chevronColumn)
                    Image(systemName: isOpen ? "folder.fill" : "folder").font(.system(Theme.caption)).foregroundStyle(Theme.textMuted)
                } else {
                    Spacer().frame(width: chevronColumn)
                    Image(systemName: fileGlyph(node.path)).font(.system(Theme.caption)).foregroundStyle(Theme.textMuted)
                }
                Text(node.name)
                    .font(.system(Theme.footnote, design: .monospaced))
                    .foregroundStyle(panel.editor.activePath == node.path ? Theme.text : Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                if let status {
                    Text(statusLetter(status))
                        .font(.system(Theme.caption, design: .monospaced, weight: .bold))
                        .foregroundStyle(statusColor(status))
                } else if dirty && !isOpen {
                    Circle().fill(Theme.statusAmber).frame(width: 5, height: 5)
                }
            }
            .padding(.leading, CGFloat(row.depth) * 12 + 8)
            .padding(.trailing, 10)
            .scaledHeight(26, relativeTo: .footnote)
            .background(panel.editor.activePath == node.path ? Theme.subtleStrong : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            if node.isDirectory {
                Button(isOpen ? "Collapse" : "Expand", systemImage: isOpen ? "chevron.down" : "chevron.right") {
                    toggle(node.path)
                }
                Button("Collapse all", systemImage: "arrow.down.right.and.arrow.up.left") { expanded = [] }
            } else {
                Button("Open", systemImage: "doc") { openFromTree(node.path, pin: false) }
                Button("Open pinned", systemImage: "pin") { openFromTree(node.path, pin: true) }
                Divider()
                pathItems(node.path)
            }
        }
    }

    private func toggle(_ path: String) {
        guard query.isEmpty else { return }
        if expanded.contains(path) { expanded.remove(path) } else { expanded.insert(path) }
    }

    private func openFromTree(_ path: String, pin: Bool) {
        panel.openFile(path, pin: pin)
        if !sideBySide { panel.setTreeShown(false) }
    }

    @ViewBuilder private func pathItems(_ path: String) -> some View {
        if let absolute = workspaceFilePath(listing?.workspacePath, path) {
            Button("Copy path", systemImage: "doc.on.doc") { UIPasteboard.general.string = absolute }
        }
        Button("Copy relative path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
        Divider()
        Button("Insert as a reference", systemImage: "text.badge.plus") {
            panel.insertReference(ComposerReference.file(path))
        }
    }

    private func foot(_ listing: WorkspaceListing, dropped: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Divider().overlay(Theme.borderSubtle)
            Text(dropped > 0
                 ? "First \(maxSearchMatches) matches; \(dropped) more not shown."
                 : "\(listing.files.count) files\(listing.truncated ? " (capped)" : "") · \(listing.source == .git ? "tracked and unignored, from git" : "walked — not a repository")")
                .font(.system(Theme.caption))
                .foregroundStyle(Theme.textMuted)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
        }
    }

    @ViewBuilder private var body_: some View {
        if let file = panel.editor.active {
            FileBody(
                api: api, sessionId: sessionId, hostId: hostId, file: file, active: active,
                root: listing?.workspacePath,
                onSaveState: { state in saving[file.path] = state }
            )
            .id("\(hostId?.uuidString ?? "local"):\(sessionId):\(file.path):\(file.view.rawValue)")
        } else {
            ContentUnavailableView(
                "No file open",
                systemImage: "doc",
                description: Text(panel.editor.treeShown ? "Tap a file in the tree to look at it; press and hold for more." : "Show the tree to open a file.")
            )
        }
    }

    private func load() async {
        do {
            async let files = api.sessionFiles(sessionId)
            let listing = try await files
            self.listing = listing
            error = nil
            if expanded.isEmpty {
                expanded = Set(buildFileTree(listing.files).filter(\.isDirectory).map(\.path))
            }
        } catch {
            self.error = describe(error)
        }
        if let diff = try? await (api as? any EngineAPI)?.sessionDiff(sessionId) {
            statuses = Dictionary(uniqueKeysWithValues: diff.files.map { ($0.path, $0.status) })
        }
    }

    private func statusLetter(_ status: String) -> String {
        switch status {
        case "added": "A"
        case "deleted": "D"
        case "renamed": "R"
        case "untracked": "?"
        default: "M"
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "added", "untracked": Theme.statusEmerald
        case "deleted": Theme.statusRed
        default: Theme.statusAmber
        }
    }
}

func fileGlyph(_ path: String) -> String {
    switch (path as NSString).pathExtension.lowercased() {
    case "ipynb": "text.book.closed"
    case "csv", "tsv", "parquet": "tablecells"
    case "pdf": "doc.richtext"
    case "png", "jpg", "jpeg", "gif", "webp", "svg", "heic": "photo"
    case "md", "markdown", "txt", "rst": "doc.text"
    case "json", "yaml", "yml", "toml": "curlybraces"
    case "py", "ts", "tsx", "js", "jsx", "swift", "rs", "go", "rb", "java", "c", "h", "cpp", "cs", "kt": "chevron.left.forwardslash.chevron.right"
    case "tex", "bib", "sty", "cls": "function"
    case "sh", "bash", "zsh": "terminal"
    default: "doc"
    }
}

enum FileKind {
    case prose, code, image, pdf, notebook, notebookReadOnly, table, binary

    static func of(_ path: String, view: FileView) -> FileKind {
        switch view {
        case .notebook: return .notebook
        case .notebookReadOnly: return .notebookReadOnly
        case .table: return .table
        case .pdf: return .pdf
        case .code: break
        }
        switch (path as NSString).pathExtension.lowercased() {
        case "md", "markdown", "txt", "rst", "text": return .prose
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff": return .image
        default: return .code
        }
    }
}
