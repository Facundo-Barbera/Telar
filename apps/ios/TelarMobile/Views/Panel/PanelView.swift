import SwiftUI

/// THE RIGHT PANEL — the desktop's, phone-sized. A strip of the surfaces this
/// session offers, then the one that is up. Presented as an inspector column
/// beside the transcript on a regular width and as a full-screen push on a
/// compact one; the same view either way, with its own navigation stack so
/// its title bar is its own.
struct PanelView: View {
    let api: any EngineAPI
    let panelAPI: (any PanelAPI)?
    let sessionId: EngineID
    let hostId: HostID?
    /// The turn's activity — changing when a turn settles, which is when
    /// every surface re-reads. Nothing here polls.
    let active: Bool
    let panel: PanelModel
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            strip
            Divider().overlay(Theme.borderSubtle)
            surface
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Theme.canvas)
        .environment(\.panel, panel)
    }

    private var strip: some View {
        HStack(spacing: 4) {
            ForEach(panel.tabs) { tab in
                Button {
                    panel.select(tab)
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: tab.icon).font(.system(size: 12, weight: .medium))
                        Text(tab.label).font(.system(size: 13, weight: .medium))
                    }
                    .foregroundStyle(panel.active == tab ? Theme.text : Theme.textMuted)
                    .padding(.horizontal, 10)
                    .frame(height: 30)
                    .background(panel.active == tab ? Theme.subtleStrong : .clear, in: RoundedRectangle(cornerRadius: Theme.radiusControl))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(tab.label) tab")
                .accessibilityAddTraits(panel.active == tab ? .isSelected : [])
            }
            Spacer(minLength: 0)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: 30, height: 30)
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
        case .files:
            if let panelAPI {
                FilesSurface(api: panelAPI, sessionId: sessionId, hostId: hostId, active: active, panel: panel)
            } else {
                unavailable
            }
        case .data:
            if let panelAPI {
                DataSurface(api: panelAPI, sessionId: sessionId, hostId: hostId, active: active)
            } else {
                unavailable
            }
        case .latex:
            if let panelAPI {
                LatexSurface(api: panelAPI, sessionId: sessionId, active: active, panel: panel)
            } else {
                unavailable
            }
        }
    }

    private var unavailable: some View {
        ContentUnavailableView("Not available here", systemImage: "wifi.slash", description: Text("This surface needs a paired Mac."))
    }
}

/// The pattern every surface shares — `DiffView`'s: a value, an error, or a
/// spinner, with the engine's own sentence when it refused.
func describe(_ error: Error) -> String {
    (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
}
