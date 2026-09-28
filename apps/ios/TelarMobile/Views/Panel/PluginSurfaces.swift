import SwiftUI

/// THE VIEW HALF OF `PluginUI` — which surface draws each plugin tab. The
/// surfaces themselves are the plugins' own and unchanged; this only binds them
/// to a tab, so `PanelView` draws "whatever plugin surface this is" rather than
/// naming Data or LaTeX. A tab no bundled plugin owns draws nothing.
struct PluginSurfaceView: View {
    let tab: PanelTab
    let api: any PanelAPI
    let sessionId: EngineID
    let hostId: HostID?
    let active: Bool
    let panel: PanelModel

    var body: some View {
        switch tab {
        case .data:
            DataSurface(api: api, sessionId: sessionId, hostId: hostId, active: active)
        case .latex:
            LatexSurface(api: api, sessionId: sessionId, active: active, panel: panel)
        default:
            EmptyView()
        }
    }
}
