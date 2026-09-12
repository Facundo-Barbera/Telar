import SwiftUI

/// THE FILES TAB: the checkout as a tree beside the file that is open —
/// the desktop's Editor. Files arrive by the dozen, so they get a strip of
/// their own inside this tab rather than a panel tab each.
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
    /// THE PANEL'S OWN WIDTH decides the arrangement, not the window's size
    /// class: inside an inspector column an iPad reports compact, and an
    /// inspector wide enough for both would have been split anyway. 220 for
    /// the tree plus a body still worth reading is the line.
    @State private var width: CGFloat = 0

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
                // Narrow: the tree REPLACES the file, and the strip's toggle
                // is the way between them. Without this the tree was gone for
                // good the moment a file opened.
                treeColumn
            } else {
                body_
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        // A file opened from anywhere — the tree, a transcript chip, a
        // `display.opened` — is a request to LOOK at it.
        .onChange(of: panel.editor.activePath) { if !sideBySide { panel.setTreeShown(false) } }
        .task(id: "\(sessionId):\(active)") { await load() }
    }

    // MARK: the strip of open files

    private var fileStrip: some View {
        HStack(spacing: 2) {
            Button {
                panel.setTreeShown(!panel.editor.treeShown)
            } label: {
                Image(systemName: panel.editor.treeShown ? "sidebar.left" : "sidebar.leading")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(panel.editor.treeShown ? "Hide tree" : "Show tree")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(panel.editor.files) { file in
                        let isActive = file.path == panel.editor.activePath
                        HStack(spacing: 4) {
                            Text((file.path as NSString).lastPathComponent)
                                .font(.system(size: 12, weight: isActive ? .medium : .regular))
                                .italic(!file.pinned)
                                .foregroundStyle(isActive ? Theme.text : Theme.textMuted)
                                .lineLimit(1)
                            if let state = saving[file.path] {
                                Circle().fill(state == .saving ? Theme.accent : Theme.statusRed).frame(width: 6, height: 6)
                            } else {
                                Button {
                                    panel.closeFile(file.path)
                                } label: {
                                    Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.textMuted)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Close \((file.path as NSString).lastPathComponent)")
                            }
                        }
                        .padding(.horizontal, 8)
                        .frame(height: 26)
                        .background(isActive ? Theme.subtleStrong : .clear, in: RoundedRectangle(cornerRadius: 6))
                        .contentShape(Rectangle())
                        .onTapGesture { panel.activateFile(file.path) }
                        .onTapGesture(count: 2) { panel.pinFile(file.path) }
                        .contextMenu {
                            if !file.pinned { Button("Keep open", systemImage: "pin") { panel.pinFile(file.path) } }
                            Button("Close", systemImage: "xmark") { panel.closeFile(file.path) }
                        }
                    }
                }
                .padding(.horizontal, 4)
            }
        }
        .padding(.horizontal, 4)
        .frame(height: 34)
        .background(Theme.sheet)
        .overlay(alignment: .bottom) { Divider().overlay(Theme.borderSubtle) }
    }

    // MARK: the tree

    private var treeColumn: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(Theme.textMuted)
                TextField("Search files", text: $query)
                    .font(.system(size: 12))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onChange(of: query) { _, next in
                        if !next.isEmpty && !searched { searched = true }
                        if next.isEmpty { searched = false }
                    }
                Button { Task { await load() } } label: {
                    Image(systemName: "arrow.clockwise").font(.system(size: 11)).foregroundStyle(Theme.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Refresh files")
            }
            .padding(.horizontal, 10)
            .frame(height: 32)
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
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(rows) { row in treeRow(row, open: open) }
                        }
                        .padding(.vertical, 4)
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
            if node.isDirectory {
                if query.isEmpty {
                    if expanded.contains(node.path) { expanded.remove(node.path) } else { expanded.insert(node.path) }
                }
            } else {
                panel.openFile(node.path, pin: false)
                // Re-tapping the file already open leaves `activePath` alone,
                // so the watcher above would not fire.
                if !sideBySide { panel.setTreeShown(false) }
            }
        } label: {
            HStack(spacing: 5) {
                if node.isDirectory {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                        .foregroundStyle(Theme.textMuted.opacity(0.7))
                        .frame(width: 10)
                    Image(systemName: isOpen ? "folder.fill" : "folder").font(.system(size: 11)).foregroundStyle(Theme.textMuted)
                } else {
                    Spacer().frame(width: 10)
                    Image(systemName: fileGlyph(node.path)).font(.system(size: 11)).foregroundStyle(Theme.textMuted)
                }
                Text(node.name)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(panel.editor.activePath == node.path ? Theme.text : Theme.textMuted2)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                if let status {
                    Text(statusLetter(status))
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundStyle(statusColor(status))
                } else if dirty && !isOpen {
                    Circle().fill(Theme.statusAmber).frame(width: 5, height: 5)
                }
            }
            .padding(.leading, CGFloat(row.depth) * 12 + 8)
            .padding(.trailing, 10)
            .frame(height: 26)
            .background(panel.editor.activePath == node.path ? Theme.subtleStrong : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            if !node.isDirectory {
                Button("Keep open", systemImage: "pin") { panel.openFile(node.path, pin: true) }
            }
        }
    }

    private func foot(_ listing: WorkspaceListing, dropped: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Divider().overlay(Theme.borderSubtle)
            Text(dropped > 0
                 ? "First \(maxSearchMatches) matches; \(dropped) more not shown."
                 : "\(listing.files.count) files\(listing.truncated ? " (capped)" : "") · \(listing.source == .git ? "tracked and unignored, from git" : "walked — not a repository")")
                .font(.system(size: 10))
                .foregroundStyle(Theme.textTertiary)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
        }
    }

    // MARK: the file body

    @ViewBuilder private var body_: some View {
        if let file = panel.editor.active {
            FileBody(api: api, sessionId: sessionId, hostId: hostId, file: file, active: active, onSaveState: { state in saving[file.path] = state })
                .id("\(hostId?.uuidString ?? "local"):\(sessionId):\(file.path):\(file.view.rawValue)")
        } else {
            ContentUnavailableView(
                "No file open",
                systemImage: "doc",
                description: Text(panel.editor.treeShown ? "Tap a file in the tree to look at it; hold to keep it open." : "Show the tree to open a file.")
            )
        }
    }

    // MARK: reads

    private func load() async {
        do {
            async let files = api.sessionFiles(sessionId)
            let listing = try await files
            self.listing = listing
            error = nil
            if expanded.isEmpty {
                // One level open on arrival, the way the desktop's tree lands.
                expanded = Set(buildFileTree(listing.files).filter(\.isDirectory).map(\.path))
            }
        } catch {
            self.error = describe(error)
        }
        // Git status is decoration: it may fail alone.
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

/// One glyph per kind, from the extension — enough to tell a notebook from
/// a table from a picture at a glance.
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

/// Which body a path gets, and whether it is prose the phone may edit.
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
