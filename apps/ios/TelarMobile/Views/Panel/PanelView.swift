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
    /// A compact width's panel already fills the screen; offering to fill it
    /// again would be a button that does nothing.
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
            // FILL THE WINDOW. A 440pt column is a keyhole for a notebook or a
            // diff; the desktop keeps the whole strip visible in fullscreen and
            // so does this — it is the same view with the screen to itself, not
            // a second one, so nothing unmounts and no draft is lost crossing.
            if canFillWindow {
                Button {
                    panel.setFullScreen(!panel.isFullScreen)
                } label: {
                    // BOTH CHROME GLYPHS SCALE WITH THEIR SQUARE — this one
                    // and the close button below, 12-in-30 at every text size
                    // (#674).
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
        // NO `panelAPI` GATE HERE, and that is the point of the tab. Who is
        // working for this conversation is read off the two routes the phone
        // already talks to any paired Mac with, so the surface is available
        // wherever the session is.
        case .agents:
            AgentsSurface(api: api, sessionId: sessionId, hostId: hostId, active: active)
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
