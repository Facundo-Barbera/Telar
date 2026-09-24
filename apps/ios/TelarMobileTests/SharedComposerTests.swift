import Foundation
import SwiftUI
import Testing
@testable import TelarMobile

/// THE COMPOSER READS A HOST, NOT A STORE (#539).
///
/// `ComposerHost` names the handful of facts the composer reads. These tests
/// hold the seam: the session's answers are the STORE'S, field for field, so
/// nothing about the session composer changed when it was lifted.
@Suite @MainActor struct SharedComposerTests {
    private func store() -> SessionStore {
        SessionStore(api: RecordingEngineAPI(eventPages: [], snapshots: []), sessionId: "s")
    }

    @Test func theComposerTakesTheSessionsHost() {
        var draft = ""
        var focused = false
        let composer = ComposerView(
            draft: Binding(get: { draft }, set: { draft = $0 }),
            focus: Binding(get: { focused }, set: { focused = $0 }),
            host: SessionComposerHost(store: store())
        )
        #expect(composer.host is SessionComposerHost)
    }

    @Test func theSessionHostForwardsTheStoresOwnAnswers() {
        let store = store()
        let host = SessionComposerHost(store: store)
        #expect(host.isRunning == store.hasRunningTurn)
        #expect(host.pendingAttachments == store.pendingAttachments)
        #expect(host.uploading == store.uploading)
        #expect(host.queuedTurns.count == store.queuedTurns.count)
        #expect(host.placeholder == "Ask the agent, or run a command…")
    }
}
