import Foundation
import Observation
import SwiftUI

/// Which surface the panel shows — the desktop's fixed tabs, the four the
/// phone carries. Data and LaTeX exist only when the project opted in.
enum PanelTab: String, Codable, CaseIterable, Identifiable {
    case diff, files, data, latex
    var id: String { rawValue }

    var label: String {
        switch self {
        case .diff: "Diff"
        case .files: "Files"
        case .data: "Data"
        case .latex: "LaTeX"
        }
    }

    var icon: String {
        switch self {
        case .diff: "plus.forwardslash.minus"
        case .files: "folder"
        case .data: "flask"
        case .latex: "function"
        }
    }
}

/// How a file is looked at — the web's `EditorView`. Decided once by
/// `panelView(for:dataScience:)` when the file is opened, the way the
/// desktop's `editorFileForPath` decides it.
enum FileView: String, Codable {
    case code, notebook, table, pdf
    /// A notebook in a project that has not turned Data Science on: the same
    /// cells, read from the file itself, with no kernel behind them.
    case notebookReadOnly

    /// Both notebook views, wherever the difference does not matter — pinning,
    /// mostly, which is about what a notebook IS and not about who can run it.
    var isNotebook: Bool { self == .notebook || self == .notebookReadOnly }
}

/// A file open in the Files tab. ONE preview slot: a single tap opens a file
/// into it and the next single tap replaces it; a pinned file stays.
struct OpenFile: Codable, Equatable, Identifiable {
    var path: String
    var view: FileView
    var pinned: Bool
    var id: String { path }
}

/// The Files tab's own arrangement — the web's `EditorState`.
struct EditorState: Codable, Equatable {
    var files: [OpenFile] = []
    var activePath: String?
    var treeShown = true

    static let fileCap = 24

    var active: OpenFile? { files.first { $0.path == activePath } }

    /// A notebook is always pinned: it holds a kernel's work and is never
    /// something you glance at and move past.
    mutating func open(_ path: String, view: FileView, pin: Bool) {
        let pinned = pin || view.isNotebook
        if let index = files.firstIndex(where: { $0.path == path }) {
            files[index].view = view
            if pinned { files[index].pinned = true }
        } else if !pinned, let slot = files.firstIndex(where: { !$0.pinned }) {
            // The preview slot is replaced IN PLACE, so the strip does not jump.
            files[slot] = OpenFile(path: path, view: view, pinned: false)
        } else {
            files.append(OpenFile(path: path, view: view, pinned: pinned))
            if files.count > Self.fileCap { files.removeFirst(files.count - Self.fileCap) }
        }
        activePath = path
    }

    mutating func pin(_ path: String) {
        guard let index = files.firstIndex(where: { $0.path == path }) else { return }
        files[index].pinned = true
    }

    /// The right neighbour takes focus, falling back to the last — the web's
    /// `closePanelTab` rule.
    mutating func close(_ path: String) {
        guard let index = files.firstIndex(where: { $0.path == path }) else { return }
        files.remove(at: index)
        if activePath == path {
            activePath = files.indices.contains(index) ? files[index].path : files.last?.path
        }
    }
}

/// The desktop's `panelTabForPath`: a table needs the kernel, so without data
/// science it opens as text; a PDF is a document and always opens as one.
///
/// A NOTEBOOK IS ALWAYS A NOTEBOOK. Without the plugin it opens read-only,
/// parsed from the file's own JSON — the kernel is what Data Science buys, not
/// the ability to read what is on disk. Routing it to the code view meant a
/// 730 KB `.ipynb` opened as raw nbformat, which is the one thing a notebook
/// is not.
func panelView(for path: String, dataScience: Bool) -> FileView {
    let ext = (path as NSString).pathExtension.lowercased()
    switch ext {
    case "ipynb": return dataScience ? .notebook : .notebookReadOnly
    case "csv", "tsv", "parquet": return dataScience ? .table : .code
    case "pdf": return .pdf
    default: return .code
    }
}

/// THE PANEL, for one session on one Mac. Which tab is up, which files are
/// open, whether it is showing — and the two plugin flags that decide which
/// tabs exist. Persisted per host AND session, which the web does not do;
/// two Macs can mint the same session id.
///
/// Reached through the environment (`\.panel`) so a transcript row can ask
/// for a file to be opened without a closure threaded through four views.
@MainActor @Observable final class PanelModel {
    private(set) var isOpen = false
    /// Filling the window rather than sharing it. THE MODEL IS THE TRUTH for
    /// this too, so moving between the column and full screen carries the tab,
    /// the open files and their drafts with it — the surfaces never unmount
    /// into a different owner.
    private(set) var isFullScreen = false
    private(set) var active: PanelTab = .diff
    private(set) var editor = EditorState()
    /// Off until the project record has been read — the same rule the web
    /// applies, so no tab is offered that would 404.
    private(set) var dataScience = false
    private(set) var latex = false
    private(set) var pluginsRead = false
    /// A file the transcript asked for while the panel was closed on a
    /// compact width: the push happens once the view is on screen.
    private(set) var generation = 0

    let hostId: HostID?
    let sessionId: EngineID
    private let defaults: UserDefaults
    private var key: String { "telar.panel.\(hostId?.uuidString ?? "local").\(sessionId)" }

    private struct Persisted: Codable {
        var isOpen: Bool
        var active: PanelTab
        var editor: EditorState
        /// Optional: a save written before full screen existed decodes with
        /// the panel merely open, which is the honest reading of it.
        var isFullScreen: Bool?
    }

    init(hostId: HostID?, sessionId: EngineID, defaults: UserDefaults = .standard) {
        self.hostId = hostId
        self.sessionId = sessionId
        self.defaults = defaults
        if let data = defaults.data(forKey: key), let saved = try? JSONDecoder().decode(Persisted.self, from: data) {
            isOpen = saved.isOpen
            active = saved.active
            editor = saved.editor
            isFullScreen = saved.isFullScreen ?? false
        }
    }

    var tabs: [PanelTab] {
        PanelTab.allCases.filter { tab in
            switch tab {
            case .data: dataScience
            case .latex: latex
            default: true
            }
        }
    }

    func setPlugins(dataScience: Bool, latex: Bool) {
        self.dataScience = dataScience
        self.latex = latex
        pluginsRead = true
        // A restored tab the project no longer offers falls back to Diff.
        if !tabs.contains(active) { active = .diff }
        // A FILE OPENED BEFORE THE PROJECT RECORD LANDED was typed against
        // `dataScience: false` — the read-only notebook rather than the live
        // one, the code view rather than the grid. The desktop re-decides on
        // every render; here the view is decided once, at open, so the arrival
        // of the record is the moment to decide it again.
        for index in editor.files.indices {
            editor.files[index].view = panelView(for: editor.files[index].path, dataScience: dataScience)
        }
        persist()
    }

    /// Every setter here writes only what changes: an observable that is set
    /// to the value it holds still notifies, and a view that reads it and
    /// writes it back would loop.
    func open(_ tab: PanelTab? = nil) {
        if let tab, active != tab { active = tab }
        if !isOpen { isOpen = true }
        generation += 1
        persist()
    }

    func close() {
        guard isOpen || isFullScreen else { return }
        if isOpen { isOpen = false }
        // Closing is closing. Coming back to a panel that reopens filling the
        // window, because that is how it was left three days ago, is the
        // surprise this guards against. Guarded like every other setter here:
        // an unconditional write notified `isFullScreen`'s watcher on every
        // close, and on the pop path that is one more update pass than the
        // close needed.
        if isFullScreen { isFullScreen = false }
        persist()
    }

    /// Fill the window, or come back to the column. Opening full screen opens
    /// the panel, so the two flags can never disagree about whether it shows.
    func setFullScreen(_ full: Bool) {
        guard full != isFullScreen else { return }
        isFullScreen = full
        if full, !isOpen { isOpen = true }
        persist()
    }

    func toggle() { isOpen ? close() : open() }

    func select(_ tab: PanelTab) {
        guard active != tab else { return }
        active = tab
        persist()
    }

    /// A path from anywhere — a transcript chip, a diagnostic, the tree.
    func openFile(_ path: String, pin: Bool = true) {
        editor.open(path, view: panelView(for: path, dataScience: dataScience), pin: pin)
        active = .files
        isOpen = true
        generation += 1
        persist()
    }

    func activateFile(_ path: String) {
        editor.activePath = path
        persist()
    }

    func pinFile(_ path: String) {
        editor.pin(path)
        persist()
    }

    func closeFile(_ path: String) {
        editor.close(path)
        persist()
    }

    func setTreeShown(_ shown: Bool) {
        editor.treeShown = shown
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(Persisted(isOpen: isOpen, active: active, editor: editor, isFullScreen: isFullScreen)) {
            defaults.set(data, forKey: key)
        }
    }
}

private struct PanelModelKey: EnvironmentKey {
    static let defaultValue: PanelModel? = nil
}

private struct KernelSignalsKey: EnvironmentKey {
    static let defaultValue = KernelSignals()
}

private struct ColumnVisibilityKey: EnvironmentKey {
    static let defaultValue: Binding<NavigationSplitViewVisibility>? = nil
}

extension EnvironmentValues {
    /// The open session's panel, or nil outside a session.
    var panel: PanelModel? {
        get { self[PanelModelKey.self] }
        set { self[PanelModelKey.self] = newValue }
    }

    /// WHAT THE KERNEL HAS SAID, handed to the panel so its surfaces can
    /// re-read when a cell runs rather than only when a turn settles. Handed
    /// down rather than re-created: there is one sync engine per session and
    /// the panel must watch that one.
    var kernelSignals: KernelSignals {
        get { self[KernelSignalsKey.self] }
        set { self[KernelSignalsKey.self] = newValue }
    }

    /// The split view's sidebar visibility, handed down so a session can
    /// hide the sidebar when its panel needs the room. Nil outside the split.
    var columnVisibility: Binding<NavigationSplitViewVisibility>? {
        get { self[ColumnVisibilityKey.self] }
        set { self[ColumnVisibilityKey.self] = newValue }
    }
}
