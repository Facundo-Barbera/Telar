import Foundation
import Testing
@testable import TelarMobile

@Suite struct PanelRaiseTests {
    @Test func oneWidthRaisesOnePresentation() {
        let column = PanelRaise.flags(open: true, wantsColumn: true, fullScreen: false)
        #expect(column == (column: true, push: false))
        let push = PanelRaise.flags(open: true, wantsColumn: false, fullScreen: false)
        #expect(push == (column: false, push: true))
        #expect(PanelRaise.flags(open: true, wantsColumn: true, fullScreen: true) == (column: false, push: false))
        #expect(PanelRaise.flags(open: false, wantsColumn: true, fullScreen: false) == (column: false, push: false))
        #expect(PanelRaise.flags(open: false, wantsColumn: false, fullScreen: false) == (column: false, push: false))
    }

    @Test func onlyAFlagGoingDownIsTheReader() {
        #expect(PanelRaise.isDismissal(false))
        #expect(!PanelRaise.isDismissal(true))
    }

    @Test @MainActor func anEchoedRaiseDoesNotReopenThePanel() {
        let suite = "telar.panel.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let panel = PanelModel(hostId: UUID(), sessionId: "s", defaults: defaults)
        panel.open()

        if PanelRaise.isDismissal(false) { panel.close() }
        #expect(!panel.isOpen)

        let (_, push) = PanelRaise.flags(open: true, wantsColumn: false, fullScreen: false)
        #expect(push)
        if PanelRaise.isDismissal(push) { panel.close() }
        #expect(!panel.isOpen)
    }

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
        #expect(panel.generation > generation)
        let reopened = PanelModel(hostId: panel.hostId, sessionId: "s", defaults: defaults)
        #expect(reopened.isOpen && reopened.editor.activePath == "src/main.swift")
    }

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
        #expect(PanelRaise.flags(open: panel.isOpen, wantsColumn: false, fullScreen: panel.isFullScreen).push)
    }

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
        #expect(panel.editor.files.map(\.path) == ["notes.md"])
        #expect(panel.generation == generation)
    }
}
