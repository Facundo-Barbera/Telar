import Foundation
import Observation
import SwiftUI

struct PanelTab: RawRepresentable, Codable, Hashable, Identifiable, Sendable {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    var id: String { rawValue }

    static let diff = PanelTab(rawValue: "diff")
    static let files = PanelTab(rawValue: "files")
    static let agents = PanelTab(rawValue: "agents")

    static let data = PanelTab(rawValue: "data")
    static let latex = PanelTab(rawValue: "latex")

    static let always: [PanelTab] = [.diff, .files, .agents]

    var label: String {
        switch self {
        case .diff: "Diff"
        case .files: "Files"
        case .agents: "Agents"
        default: PluginUI.surface(for: self)?.label ?? rawValue
        }
    }

    var icon: String {
        switch self {
        case .diff: "plus.forwardslash.minus"
        case .files: "folder"
        case .agents: "person.2"
        default: PluginUI.surface(for: self)?.icon ?? "puzzlepiece"
        }
    }
}

enum FileView: String, Codable {
    case code, notebook, table, pdf

    case notebookReadOnly

    var isNotebook: Bool { self == .notebook || self == .notebookReadOnly }
}

struct OpenFile: Codable, Equatable, Identifiable {
    var path: String
    var view: FileView
    var pinned: Bool
    var id: String { path }
}

struct EditorState: Codable, Equatable {
    var files: [OpenFile] = []
    var activePath: String?
    var treeShown = true

    static let fileCap = 24

    var active: OpenFile? { files.first { $0.path == activePath } }

    mutating func open(_ path: String, view: FileView, pin: Bool) {
        let pinned = pin || view.isNotebook
        if let index = files.firstIndex(where: { $0.path == path }) {
            files[index].view = view
            if pinned { files[index].pinned = true }
        } else if !pinned, let slot = files.firstIndex(where: { !$0.pinned }) {
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

    mutating func close(_ path: String) {
        guard let index = files.firstIndex(where: { $0.path == path }) else { return }
        files.remove(at: index)
        if activePath == path {
            activePath = files.indices.contains(index) ? files[index].path : files.last?.path
        }
    }

    mutating func closeOthers(_ path: String) {
        for other in files.map(\.path) where other != path { close(other) }
    }

    mutating func closeToTheRight(_ path: String) {
        guard let index = files.firstIndex(where: { $0.path == path }) else { return }
        for other in files[(index + 1)...].map(\.path) { close(other) }
    }

    mutating func closeAll() {
        files = []
        activePath = nil
    }
}

func panelView(for path: String, enabled: Set<PluginID>) -> FileView {
    let ext = (path as NSString).pathExtension.lowercased()
    switch ext {
    case "ipynb": return PluginUI.viewerAvailable(.notebook, enabled: enabled) ? .notebook : .notebookReadOnly
    case "csv", "tsv", "parquet": return PluginUI.viewerAvailable(.table, enabled: enabled) ? .table : .code
    case "pdf": return .pdf
    default: return .code
    }
}

@MainActor @Observable final class PanelModel {
    private(set) var isOpen = false

    private(set) var isFullScreen = false
    private(set) var active: PanelTab = .diff
    private(set) var editor = EditorState()

    private(set) var enabledPlugins: Set<PluginID> = []
    private(set) var pluginsRead = false

    private(set) var generation = 0

    private(set) var pendingReference: String?

    let hostId: HostID?
    let sessionId: EngineID
    private let defaults: UserDefaults
    private var key: String { "telar.panel.\(hostId?.uuidString ?? "local").\(sessionId)" }

    private struct Persisted: Codable {
        var isOpen: Bool
        var active: PanelTab
        var editor: EditorState

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
        PanelTab.always + PluginUI.surfaces(enabled: enabledPlugins).map(\.tab)
    }

    func setPlugins(_ enabled: Set<PluginID>) {
        enabledPlugins = enabled
        pluginsRead = true

        if !tabs.contains(active) { active = .diff }

        for index in editor.files.indices {
            editor.files[index].view = panelView(for: editor.files[index].path, enabled: enabledPlugins)
        }
        persist()
    }

    func open(_ tab: PanelTab? = nil) {
        if let tab, active != tab { active = tab }
        if !isOpen { isOpen = true }
        generation += 1
        persist()
    }

    func close() {
        guard isOpen || isFullScreen else { return }
        if isOpen { isOpen = false }

        if isFullScreen { isFullScreen = false }
        persist()
    }

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

    func openFile(_ path: String, pin: Bool = true) {
        editor.open(path, view: panelView(for: path, enabled: enabledPlugins), pin: pin)
        open(.files)
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

    func closeOtherFiles(_ path: String) {
        editor.closeOthers(path)
        persist()
    }

    func closeFilesToTheRight(_ path: String) {
        editor.closeToTheRight(path)
        persist()
    }

    func closeAllFiles() {
        editor.closeAll()
        persist()
    }

    func insertReference(_ text: String) { pendingReference = text }

    func clearReference() { pendingReference = nil }

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
    var panel: PanelModel? {
        get { self[PanelModelKey.self] }
        set { self[PanelModelKey.self] = newValue }
    }

    var kernelSignals: KernelSignals {
        get { self[KernelSignalsKey.self] }
        set { self[KernelSignalsKey.self] = newValue }
    }

    var columnVisibility: Binding<NavigationSplitViewVisibility>? {
        get { self[ColumnVisibilityKey.self] }
        set { self[ColumnVisibilityKey.self] = newValue }
    }
}
