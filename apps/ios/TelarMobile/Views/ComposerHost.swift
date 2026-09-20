import Foundation

/// WHAT THE COMPOSER READS AND DOES, WITHOUT NAMING A SESSION (#539).
///
/// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
/// `ComposerView` is the real composer on this phone: a UIKit text view so the
/// system's own Paste offers a picture, image paste and drop, the photo button,
/// the stash, the control pills and the queue strip. The Agent screen had none
/// of it — a bare `TextField` with a send button — because the composer took a
/// `SessionStore` and the Agent is not a session.
///
/// A PROTOCOL RATHER THAN AN OPTIONAL STORE. "`store: SessionStore?` and check
/// it everywhere" would have put a `if let store` around every line of the box
/// and left two behaviours inside one view. This names the handful of facts the
/// composer actually reads, so the Agent can answer them truthfully and the
/// session's answers are unchanged — `SessionComposerHost` forwards, field for
/// field, to the store it always read.
///
/// ── OBSERVATION STILL WORKS THROUGH IT ──────────────────────────────────────
/// These are computed properties that read an `@Observable` store, and
/// Observation registers the access where it HAPPENS rather than where the
/// object is declared — so a body that reads `host.uploading` is tracking
/// `store.uploading` exactly as it did before the forwarding existed.
@MainActor protocol ComposerHost {
    /// A turn is running, so the pill shows Stop rather than Send.
    var isRunning: Bool { get }
    /// What the placeholder says. The Agent is not "the agent" of a session.
    var placeholder: String { get }
    /// WHETHER THIS SURFACE CAN TAKE FILES AT ALL. False hides the photo
    /// button, the drop target and the paste-to-attach path — see
    /// `AgentComposerHost`, whose route has nowhere to put them.
    var acceptsAttachments: Bool { get }
    var pendingAttachments: [TurnAttachment] { get }
    var attachmentPreviews: [EngineID: Data] { get }
    var uploading: Bool { get }
    /// The messages waiting behind the live turn, as rows the strip can draw.
    /// EMPTY IS A HONEST ANSWER, not a missing feature: the Agent queues turns
    /// but does not publish them as a list, so its strip is absent rather than
    /// invented.
    var queuedTurns: [JournalTurn] { get }
    /// Whether a queued message can be pushed into the running turn. False on a
    /// provider with no steer, and on the Agent, which has none.
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
    var acceptsAttachments: Bool { true }
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

/// The Agent's answers — and the three that are deliberately "no".
///
/// NO ATTACHMENTS, AND THAT IS THE ROUTE'S LIMIT RATHER THAN A CHOICE.
/// `POST /v2/agent/turns` takes `{ text }` and nothing else: there is no
/// attachment index on a thread and no id an upload could be referenced by.
/// Hiding the control is the honest reading — a photo button that uploads into
/// a route with nowhere to put the bytes is worse than none. When the thread
/// route grows attachments, this is the one line that changes.
///
/// NO QUEUE STRIP, for a smaller reason: `GET /v2/agent` reports how MANY turns
/// are queued and not what they say, so there is nothing to list. The count is
/// on the rail's Agent row instead (#539's status line).
struct AgentComposerHost: ComposerHost {
    let running: Bool
    let onSend: (String) async -> Void
    let onStop: () async -> Void

    var isRunning: Bool { running }
    var placeholder: String { "Message the Agent" }
    var acceptsAttachments: Bool { false }
    var pendingAttachments: [TurnAttachment] { [] }
    var attachmentPreviews: [EngineID: Data] { [:] }
    var uploading: Bool { false }
    var queuedTurns: [JournalTurn] { [] }
    var canPromoteQueued: Bool { false }

    func send(_ text: String) async { await onSend(text) }
    func stop() async { await onStop() }
    func attach(data: Data, name: String, mediaType: String) async {}
    func removeAttachment(_ id: EngineID) {}
    func promote(_ runId: String) async {}
    func withdraw(_ runId: String) async {}
}
