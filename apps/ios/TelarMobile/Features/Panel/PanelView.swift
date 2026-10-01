import SwiftUI

enum PanelPresentation {
    case column

    case page
}

struct PanelView: View {
    let api: any EngineAPI
    let panelAPI: (any PanelAPI)?
    let sessionId: EngineID
    let hostId: HostID?

    let active: Bool
    let panel: PanelModel
    var presentation: PanelPresentation = .page

    var canFillWindow = false
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            strip
            Divider().overlay(Theme.borderSubtle)
            surface
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .enclosure(presentation)
        .environment(\.panel, panel)
    }

    private var strip: some View {
        HStack(spacing: 4) {
            ForEach(panel.tabs) { tab in
                Button {
                    panel.select(tab)
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: tab.icon).font(.system(Theme.footnote, weight: .medium))
                        Text(tab.label).font(.system(Theme.footnote, weight: .medium))
                    }
                    .foregroundStyle(panel.active == tab ? Theme.text : Theme.textMuted)
                    .padding(.horizontal, 10)
                    .scaledHeight(30, relativeTo: .footnote)
                    .background(panel.active == tab ? Theme.subtleStrong : .clear, in: RoundedRectangle(cornerRadius: Theme.radiusControl))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(tab.label) tab")
                .accessibilityAddTraits(panel.active == tab ? .isSelected : [])
            }
            Spacer(minLength: 0)

            if canFillWindow {
                Button {
                    panel.setFullScreen(!panel.isFullScreen)
                } label: {
                    Image(systemName: panel.isFullScreen
                          ? "arrow.down.right.and.arrow.up.left"
                          : "arrow.up.left.and.arrow.down.right")
                        .foregroundStyle(Theme.textMuted)
                        .scaledGlyphBox(30, glyph: 12, weight: .semibold)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(panel.isFullScreen ? "Leave full screen" : "Fill the window")
            }
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .foregroundStyle(Theme.textMuted)
                    .scaledGlyphBox(30, glyph: 12, weight: .semibold)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close panel")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
    }

    @ViewBuilder private var surface: some View {
        switch panel.active {
        case .diff:
            DiffView(api: api, sessionId: sessionId)

        case .agents:
            AgentsSurface(api: api, sessionId: sessionId, hostId: hostId, active: active)
        case .files:
            if let panelAPI {
                FilesSurface(api: panelAPI, sessionId: sessionId, hostId: hostId, active: active, panel: panel)
            } else {
                unavailable
            }

        default:
            if let panelAPI {
                PluginSurfaceView(tab: panel.active, api: panelAPI, sessionId: sessionId, hostId: hostId, active: active, panel: panel)
            } else {
                unavailable
            }
        }
    }

    private var unavailable: some View {
        ContentUnavailableView("Not available here", systemImage: "wifi.slash", description: Text("This surface needs a paired computer."))
    }
}

private extension View {
    @ViewBuilder func enclosure(_ presentation: PanelPresentation) -> some View {
        switch presentation {
        case .page:
            self.background(Theme.canvas)
        case .column:
            let shape = RoundedRectangle(cornerRadius: Theme.radiusDrawer, style: .continuous)
            self
                .background(Theme.sheet)
                .clipShape(shape)
                .overlay(shape.strokeBorder(Theme.borderSubtle, lineWidth: 1))
                .padding(.leading, 4)
                .padding(.trailing, 10)
                .padding(.bottom, 10)
        }
    }
}

func describe(_ error: Error) -> String {
    (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
}
