import Foundation

@MainActor protocol ComposerHost {
    var isRunning: Bool { get }
    var placeholder: String { get }
    var pendingAttachments: [TurnAttachment] { get }
    var attachmentPreviews: [EngineID: Data] { get }
    var uploading: Bool { get }

    var queuedTurns: [JournalTurn] { get }

    var canPromoteQueued: Bool { get }

    func send(_ text: String) async
    func stop() async
    func attach(data: Data, name: String, mediaType: String) async
    func removeAttachment(_ id: EngineID)
    func promote(_ runId: String) async
    func withdraw(_ runId: String) async
}

struct SessionComposerHost: ComposerHost {
    let store: SessionStore

    var isRunning: Bool { store.hasRunningTurn }
    var placeholder: String { "Ask the agent, or run a command…" }
    var pendingAttachments: [TurnAttachment] { store.pendingAttachments }
    var attachmentPreviews: [EngineID: Data] { store.attachmentPreviews }
    var uploading: Bool { store.uploading }
    var queuedTurns: [JournalTurn] { store.queuedTurns }

    var canPromoteQueued: Bool { store.sync.session?.driver != "opencode" }

    func send(_ text: String) async { await store.send(text) }
    func stop() async { await store.stopActiveTurn() }
    func attach(data: Data, name: String, mediaType: String) async {
        await store.attach(data: data, name: name, mediaType: mediaType)
    }
    func removeAttachment(_ id: EngineID) { store.removeAttachment(id) }
    func promote(_ runId: String) async { await store.promote(runId) }
    func withdraw(_ runId: String) async { await store.withdraw(runId) }
}
