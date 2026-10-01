import Foundation

@MainActor protocol ComposerHost {
    var isRunning: Bool { get }
    var placeholder: String { get }
    var pendingAttachments: [TurnAttachment] { get }
    var attachmentPreviews: [EngineID: Data] { get }
    var uploading: Bool { get }

    var queuedTurns: [JournalTurn] { get }

    var canPromoteQueued: Bool { get }

    var commandContext: ComposerCommandContext { get }
    var skillsKey: String? { get }

    func send(_ text: String) async
    func stop() async
    func attach(data: Data, name: String, mediaType: String) async -> String?
    func removeAttachment(_ id: EngineID)
    func promote(_ runId: String) async
    func withdraw(_ runId: String) async
    func readSkills() async throws -> ProviderSkills
    func perform(_ action: ComposerCommandAction) async
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

    var commandContext: ComposerCommandContext {
        ComposerCommandContext(busy: isRunning, runtimeMode: store.sync.session?.runtimeMode, driver: store.sync.session?.driver)
    }

    var skillsKey: String? { store.sync.session.map { "session:\($0.id):\($0.driver)" } }

    func send(_ text: String) async { await store.send(text) }
    func stop() async { await store.stopActiveTurn() }
    func attach(data: Data, name: String, mediaType: String) async -> String? {
        await store.attach(data: data, name: name, mediaType: mediaType)
    }
    func removeAttachment(_ id: EngineID) { store.removeAttachment(id) }
    func promote(_ runId: String) async { await store.promote(runId) }
    func withdraw(_ runId: String) async { await store.withdraw(runId) }

    func readSkills() async throws -> ProviderSkills {
        guard let id = store.sync.session?.id else { return .empty }
        return try await store.api.sessionSkills(id)
    }

    func perform(_ action: ComposerCommandAction) async {
        switch action {
        case .runtimeMode(let mode): await store.setRuntimeMode(mode)
        case .stop: await store.stopActiveTurn()
        case .insert, .envMode, .driver: break
        }
    }
}
