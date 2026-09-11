import Foundation
import Testing
@testable import TelarMobile

@Suite struct PanelRaiseTests {
    @Test func oneWidthRaisesOnePresentation() {
        let column = PanelRaise.flags(open: true, wantsColumn: true, fullScreen: false)
        #expect(column == (column: true, push: false))
        let push = PanelRaise.flags(open: true, wantsColumn: false, fullScreen: false)
        #expect(push == (column: false, push: true))
        // Full screen takes the column down rather than running beside it.
        #expect(PanelRaise.flags(open: true, wantsColumn: true, fullScreen: true) == (column: false, push: false))
        #expect(PanelRaise.flags(open: false, wantsColumn: true, fullScreen: false) == (column: false, push: false))
        #expect(PanelRaise.flags(open: false, wantsColumn: false, fullScreen: false) == (column: false, push: false))
    }

    /// THE REPORTED BUG. The pop wrote the push flag back to false, which closed
    /// the panel — and the close's own echo raised the flag again. Reading that
    /// as the reader opening the panel is what re-opened the model, and the two
    /// ping-ponged until the app stopped drawing.
    @Test func onlyAFlagGoingDownIsTheReader() {
        #expect(PanelRaise.isDismissal(false))
        #expect(!PanelRaise.isDismissal(true))
    }

    /// The ring, walked with the model in it: a close, then the raise the stale
    /// `isOpen` produced. The panel must still be closed at the end of it.
    @Test @MainActor func anEchoedRaiseDoesNotReopenThePanel() {
        let suite = "telar.panel.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let panel = PanelModel(hostId: UUID(), sessionId: "s", defaults: defaults)
        panel.open()

        // The reader pops: the navigation destination writes the flag down.
        if PanelRaise.isDismissal(false) { panel.close() }
        #expect(!panel.isOpen)

        // The echo: `.onChange(of: panel.isOpen)` is handed the superseded
        // `true`, and raising off it puts the push flag back up.
        let (_, push) = PanelRaise.flags(open: true, wantsColumn: false, fullScreen: false)
        #expect(push)
        // Which is not the reader, so nothing re-opens and the ring is cut.
        if PanelRaise.isDismissal(push) { panel.close() }
        #expect(!panel.isOpen)
    }

    /// Closing an already-closed panel writes nothing — a repeated dismissal
    /// costs no state change and no `persist()`.
    @Test @MainActor func closingTwiceIsTheSameAsClosingOnce() {
        let suite = "telar.panel.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let panel = PanelModel(hostId: UUID(), sessionId: "s", defaults: defaults)
        panel.openFile("notes.md")
        let generation = panel.generation
        panel.close()
        panel.close()
        #expect(!panel.isOpen && !panel.isFullScreen)
        // The open files survive a close; only the showing does not.
        #expect(panel.editor.files.map(\.path) == ["notes.md"])
        #expect(panel.generation == generation)
    }
}
