import SwiftUI

/// THE RIGHT PANEL — the desktop's, phone-sized. A strip of the surfaces this
/// session offers, then the one that is up. Presented as an inspector column
/// beside the transcript on a regular width and as a full-screen push on a
/// compact one; the same view either way, with its own navigation stack so
/// its title bar is its own.
/// HOW THE PANEL IS BEING SHOWN, which is the only thing that changes about
/// it. A column sits BESIDE the conversation and needs to read as its own
/// surface; a page has the screen to itself and needs no enclosure to say so.
enum PanelPresentation {
    /// The inspector column on a regular width: an inset card.
    case column
    /// A compact-width push, or full screen: the whole page, edge to edge.
    case page
}

struct PanelView: View {
    let api: any EngineAPI
    let panelAPI: (any PanelAPI)?
    let sessionId: EngineID
    let hostId: HostID?
    /// The turn's activity — changing when a turn settles, which is when
    /// every surface re-reads. Nothing here polls.
    let active: Bool
    let panel: PanelModel
    var presentation: PanelPresentation = .page
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

private extension View {
    /// THE PANEL'S OWN SURFACE. As a column it was a bare region carrying the
    /// same canvas as the conversation beside it, separated by one hairline —
    /// so it did not read as a thing, it read as the transcript continuing in
    /// a different arrangement. iPadOS gives the sidebar an inset rounded card
    /// for exactly this reason; the panel gets the same treatment, at the
    /// radius already named for a panel that slides in.
    ///
    /// A page keeps none of it: edge to edge is what says "this has the screen
    /// to itself", and a card inside a full-screen cover is a card floating on
    /// nothing.
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

/// The pattern every surface shares — `DiffView`'s: a value, an error, or a
/// spinner, with the engine's own sentence when it refused.
func describe(_ error: Error) -> String {
    (error as? EngineAPIError)?.errorDescription ?? error.localizedDescription
}
