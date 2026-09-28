import Foundation

/// WHAT EACH BUNDLED PLUGIN CONTRIBUTES TO THE PHONE'S PANEL, keyed by plugin
/// id — the phone's copy of `apps/web/lib/plugins/registry.ts`, so the panel
/// asks "does a plugin own this?" instead of naming Data Science or LaTeX.
///
/// DATA ONLY. Which view draws a surface lives beside the panel view
/// (`Views/Panel/PluginSurfaces.swift`), keyed by the same tab.
///
/// AN UNKNOWN ID FINDS NOTHING HERE, and that is the whole rule for a plugin a
/// Mac runs and this build has never heard of: no tab, no viewer, no crash.
enum PluginUI {
    struct Surface: Equatable {
        let tab: PanelTab
        let label: String
        let icon: String
    }

    /// A file viewer a plugin owns. The PDF viewer and the read-only notebook
    /// are core: a document, and the cells already on disk, need no kernel.
    enum Viewer: Equatable {
        case notebook, table
    }

    struct Contribution {
        var surfaces: [Surface] = []
        var viewers: [Viewer] = []
    }

    /// In the order their tabs appear, after the always-there ones.
    static let bundled: [(id: PluginID, contribution: Contribution)] = [
        (.dataScience, Contribution(surfaces: [Surface(tab: .data, label: "Data", icon: "flask")], viewers: [.notebook, .table])),
        (.latex, Contribution(surfaces: [Surface(tab: .latex, label: "LaTeX", icon: "function")])),
    ]

    /// The surfaces the enabled plugins contribute, in registry order.
    static func surfaces(enabled: Set<PluginID>) -> [Surface] {
        bundled.filter { enabled.contains($0.id) }.flatMap(\.contribution.surfaces)
    }

    /// The surface behind a tab, whether or not its plugin is on.
    static func surface(for tab: PanelTab) -> Surface? {
        bundled.lazy.flatMap(\.contribution.surfaces).first { $0.tab == tab }
    }

    /// Is a plugin viewer on — does some enabled plugin contribute it?
    static func viewerAvailable(_ viewer: Viewer, enabled: Set<PluginID>) -> Bool {
        bundled.contains { enabled.contains($0.id) && $0.contribution.viewers.contains(viewer) }
    }
}
