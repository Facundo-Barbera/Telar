import Foundation

/// WHAT THE COMPOSER READS AND DOES, WITHOUT NAMING A STORE (#539).
///
/// `ComposerView` names the handful of facts it actually reads rather than a
/// `SessionStore`; `SessionComposerHost` forwards, field for field, to the
/// store it always read.
///
/// ── OBSERVATION STILL WORKS THROUGH IT ──────────────────────────────────────
/// These are computed properties that read an `@Observable` store, and
/// Observation registers the access where it HAPPENS rather than where the
/// object is declared — so a body that reads `host.uploading` is tracking
/// `store.uploading` exactly as it did before the forwarding existed.
@MainActor protocol ComposerHost {
    /// A turn is running, so the pill shows Stop rather than Send.
    var isRunning: Bool { get }
    var placeholder: String { get }
    var pendingAttachments: [TurnAttachment] { get }
    var attachmentPreviews: [EngineID: Data] { get }
    var uploading: Bool { get }
    /// The messages waiting behind the live turn, as rows the strip can draw.
    var queuedTurns: [JournalTurn] { get }
    /// Whether a queued message can be pushed into the running turn. False on a
    /// provider with no steer.
    var canPromoteQueued: Bool { get }

    func send(_ text: String) async
    func stop() async
    func attach(data: Data, name: String, mediaType: String) async
    func removeAttachment(_ id: EngineID)
    func promote(_ runId: String) async
    func withdraw(_ runId: String) async
}

/// The session's answers — every one of them the store's own, unchanged.
struct SessionComposerHost: ComposerHost {
    let store: SessionStore

    var isRunning: Bool { store.hasRunningTurn }
    var placeholder: String { "Ask the agent, or run a command…" }
    var pendingAttachments: [TurnAttachment] { store.pendingAttachments }
    var attachmentPreviews: [EngineID: Data] { store.attachmentPreviews }
    var uploading: Bool { store.uploading }
    var queuedTurns: [JournalTurn] { store.queuedTurns }
    /// OpenCode has no steer, which is the check the queue strip already made.
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
