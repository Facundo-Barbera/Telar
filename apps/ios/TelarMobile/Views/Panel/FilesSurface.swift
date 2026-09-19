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
    /// A file "Reveal in file tree" asked for: the tree may only just have
    /// been shown, so the scroll is done once its rows exist rather than
    /// inside the menu's action.
    @State private var revealing: String?
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
                // THE ONE ABSOLUTE SIZE LEFT IN THIS FILE. The square is fixed
                // in both dimensions and it clips, so a glyph that grew with
                // the reader's text would only outgrow its own target. It
                // wants a @ScaledMetric frame — a layout change rather than a
                // token swap — so it waits for that pass.
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
                        .frame(height: 26)
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
        .frame(height: 34)
        .background(Theme.sheet)
        .overlay(alignment: .bottom) { Divider().overlay(Theme.borderSubtle) }
    }

    /// The desktop's open-file menu, minus Reveal in Finder — a bridge to a
    /// machine this app is not running on, so it is ABSENT rather than greyed.
    @ViewBuilder private func chipMenu(_ file: OpenFile) -> some View {
        Button("Close", systemImage: "xmark") { panel.closeFile(file.path) }
        Button("Close others") { panel.closeOtherFiles(file.path) }
        Button("Close to the right") { panel.closeFilesToTheRight(file.path) }
        Button("Close all") { panel.closeAllFiles() }
        Divider()
        // ONLY WHERE IT WOULD DO SOMETHING: pinning a file that is already
        // pinned is a row that does nothing, which is worse than a row that
        // is not there. ONE WORD FOR PINNING, here and in the tree's "Open
        // pinned" — this strip used to say "Keep open" for the same verb.
        if !file.pinned { Button("Pin", systemImage: "pin") { panel.pinFile(file.path) } }
        Button("Reveal in file tree", systemImage: "sidebar.left") { reveal(file.path) }
        if let absolute = workspaceFilePath(listing?.workspacePath, file.path) {
            Divider()
            Button("Copy path", systemImage: "doc.on.doc") { UIPasteboard.general.string = absolute }
        }
    }

    /// The tree, opened to a file and scrolled to it. A search in progress is
    /// cleared first: a filtered tree does not hold the row unless the query
    /// happens to match it.
    private func reveal(_ path: String) {
        query = ""
        expanded.formUnion(ancestorsOf([path]))
        panel.setTreeShown(true)
        panel.activateFile(path)
        revealing = path
    }

    // MARK: the tree

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
            .frame(height: 32)
            .contentShape(Rectangle())
            // The desktop puts Refresh and Collapse all on the header and on
            // the tree's empty space; the header is the part of that a phone
            // can hit reliably.
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
                        // A BEAT FOR THE ROWS TO EXIST. The tree may have been
                        // hidden when "Reveal in file tree" was picked, and
                        // `scrollTo` a row the lazy stack has not built yet is
                        // a no-op with nothing to retry it.
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
                        .frame(width: 10)
                    Image(systemName: isOpen ? "folder.fill" : "folder").font(.system(Theme.caption)).foregroundStyle(Theme.textMuted)
                } else {
                    Spacer().frame(width: 10)
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
            .frame(height: 26)
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

    /// A directory opens and closes; a search's tree is expanded by the search
    /// itself, so the toggle has nothing to say while one is running.
    private func toggle(_ path: String) {
        guard query.isEmpty else { return }
        if expanded.contains(path) { expanded.remove(path) } else { expanded.insert(path) }
    }

    private func openFromTree(_ path: String, pin: Bool) {
        panel.openFile(path, pin: pin)
        // Re-tapping the file already open leaves `activePath` alone, so the
        // watcher on `activePath` would not fire.
        if !sideBySide { panel.setTreeShown(false) }
    }

    /// The three rows a file-shaped menu ends with. Reveal in Finder and "Open
    /// in <app>" are the desktop's bridge to a machine this app is not running
    /// on: absent here, never greyed — a disabled row is a promise restated on
    /// every long press that the phone can never keep.
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

    // MARK: the file body

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
