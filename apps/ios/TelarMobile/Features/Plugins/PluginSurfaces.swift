import SwiftUI

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
