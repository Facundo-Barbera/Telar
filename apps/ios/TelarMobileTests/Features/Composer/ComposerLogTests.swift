import Foundation
import Testing
@testable import TelarMobile

@MainActor @Suite struct ComposerLogTests {
    private func defaults() -> UserDefaults {
        let name = "composer-log-\(UUID().uuidString)"
        let store = UserDefaults(suiteName: name) ?? .standard
        store.removePersistentDomain(forName: name)
        return store
    }

    @Test func aLineCarriesRangesAndLengthsButNeverTheText() {
        let entry = ComposerLogEntry(source: .user, location: 4, removed: 1, inserted: 0, length: 11, marked: true, audio: "PlayAndRecord/SpokenAudio")
        let line = entry.line(at: Date(timeIntervalSince1970: 0))
        #expect(line.contains("user edit at=4 del=1 ins=0 len=11 marked=1 audio=PlayAndRecord/SpokenAudio"))
    }

    @Test func theLogSurvivesARelaunchAndKeepsOnlyTheNewestLines() {
        let store = defaults()
        let log = ComposerLog(defaults: store)
        for index in 0 ..< ComposerLog.cap + 5 {
            log.record(ComposerLogEntry(source: .commit, location: index, audio: "x"))
        }
        let reopened = ComposerLog(defaults: store)
        #expect(reopened.lines.count == ComposerLog.cap)
        #expect(reopened.lines.first?.contains("at=5 ") == true)
        reopened.clear()
        #expect(ComposerLog(defaults: store).lines.isEmpty)
    }

    @Test func aDictationStartAndStopAreRecordedAsEvents() {
        let log = ComposerLog(defaults: defaults())
        log.record(ComposerLogEntry(source: .dictation, event: "start", audio: "a"))
        log.record(ComposerLogEntry(source: .dictation, event: "stop", audio: "b"))
        #expect(log.exported.contains("dictation start"))
        #expect(log.exported.contains("dictation stop"))
    }
}
