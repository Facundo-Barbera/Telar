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

    /// THE AGENT'S DISPLAY-OPEN, on a panel that is not showing. `openFile` is
    /// the whole raise: the reader should not have to open the panel first for
    /// a file the agent asked to be shown to arrive in it.
    @Test @MainActor func openingAFileRaisesAClosedPanel() {
        let suite = "telar.panel.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let panel = PanelModel(hostId: UUID(), sessionId: "s", defaults: defaults)
        #expect(!panel.isOpen)
        let generation = panel.generation

        panel.openFile("src/main.swift")

        #expect(panel.isOpen)
        #expect(panel.active == .files)
        #expect(panel.editor.activePath == "src/main.swift")
        // And the width's presentation raises off this, not off `isOpen`.
        #expect(panel.generation > generation)
        // Raised, and it says so on the next launch: the pop on a compact
        // width reads the model, so a raise that was never written down comes
        // back as a panel that is not showing.
        let reopened = PanelModel(hostId: panel.hostId, sessionId: "s", defaults: defaults)
        #expect(reopened.isOpen && reopened.editor.activePath == "src/main.swift")
    }

    /// THE REPORTED BUG. The panel is already open in the model — on a compact
    /// width that is a push, and a push the reader left can put nothing back on
    /// `isOpen` for a watcher to fire on. `generation` is what moves, so it is
    /// what the view raises off; without it the agent's second file landed in a
    /// panel that never came up.
    @Test @MainActor func openingAFileInAnOpenPanelStillSignalsARaise() {
        let suite = "telar.panel.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let panel = PanelModel(hostId: UUID(), sessionId: "s", defaults: defaults)
        panel.openFile("first.md")
        let generation = panel.generation

        panel.openFile("second.md")

        #expect(panel.isOpen)
        #expect(panel.generation > generation)
        #expect(panel.editor.activePath == "second.md")
        // The push is up either way, since a compact width has only the one.
        #expect(PanelRaise.flags(open: panel.isOpen, wantsColumn: false, fullScreen: panel.isFullScreen).push)
    }

    /// A file opened while the reader is on another tab takes them to Files —
    /// the raise and the selection are one move, not two.
    @Test @MainActor func openingAFileSelectsTheFilesTab() {
        let suite = "telar.panel.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let panel = PanelModel(hostId: UUID(), sessionId: "s", defaults: defaults)
        panel.open(.diff)
        #expect(panel.active == .diff)

        panel.openFile("notes.md")

        #expect(panel.active == .files)
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
