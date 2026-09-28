import Foundation
import SwiftUI
import Testing
@testable import TelarMobile

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
