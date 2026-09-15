import Foundation

/// Mirror of `packages/engine-client/src/protocol/events.ts` — one
/// append-only, monotonically-numbered stream per session; every client state
/// is a fold over it.
///
/// STRUCTURED DIFFERENTLY FROM THE TS UNION, deliberately. The envelope keeps
/// `type` as a plain `String` alongside a `payload` enum that only carries the
/// cases the fold consumes. Two contract rules fall out for free:
///  - an unknown event type decodes to `.none` and the fold's `default:`
///    ignores it — the stream never dies on a newer engine;
///  - `needsSessionSnapshot` matches on the type STRING, so queue-changing
///    events this build carries no payload for still trigger the refetch.
/// A recognised type whose payload fails to decode also lands on `.none`:
/// worse than having the data, better than losing the stream, and the next
/// snapshot refetch heals it.
struct EngineEvent {
    /// Engine-assigned, strictly increasing per session — the replay cursor.
    var id: Int
    var at: Timestamp
    var sessionId: EngineID
    var runId: EngineID?
    var type: String
    var payload: Payload

    enum Payload {
        case turnAccepted(turn: Turn, replayed: Bool)
        case turnCompleted(resultText: String, usage: UsageSnapshot?)
        case turnFailed(code: String, message: String)
        case turnStopped(reason: String?)
        case turnPlanUpdated(item: Item)
        case itemStarted(item: Item)
        case itemUpdated(item: Item)
        case itemCompleted(item: Item)
        case contentDelta(itemId: EngineID, stream: ContentStream, text: String)
        case requestOpened(request: EngineRequest)
        case requestResolved(requestId: EngineID, decision: RequestDecision?)
        case taskStarted(task: AgentTask)
        case taskProgress(task: AgentTask)
        case taskCompleted(task: AgentTask)
        case sessionUpdated(session: Session)
        case usageUpdated(usage: UsageSnapshot)
        /// The §6 shared-browser control model: whose hands are on the wheel.
        case browserControlChanged(controller: String)
        /// The agent asked the cockpit to show a file — the panel opens it.
        case displayOpened(path: String, title: String?)
        /// THE KERNEL SPOKE. Without these two the panel only re-read when a
        /// TURN settled, so cells the agent ran mid-turn showed nothing until
        /// it finished — the "tables don't render until you refresh the
        /// kernel" the user hit on a fresh session.
        case kernelStateChanged(state: KernelState, reason: String?)
        /// One output from one cell execution. `producer` names the notebook
        /// it belongs to, or a scratch door like `ds_plot`.
        case notebookCellOutput(execId: String, cellId: String?, producer: String?, output: CellOutput?)
        /// Everything else — recognised-but-unused and unknown alike.
        case none
    }
}

extension EngineEvent: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, at, sessionId, runId, type
        case turn, replayed, resultText, usage, code, message, reason
        case item, itemId, stream, text, request, requestId, decision
        case task, session, controller, path, title
        case state, execId, cellId, producer, output
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        at = try c.decode(Timestamp.self, forKey: .at)
        sessionId = try c.decode(EngineID.self, forKey: .sessionId)
        runId = try c.decodeIfPresent(EngineID.self, forKey: .runId)
        type = try c.decode(String.self, forKey: .type)

        switch type {
        case "turn.accepted":
            if let turn = try? c.decode(Turn.self, forKey: .turn) {
                payload = .turnAccepted(turn: turn, replayed: (try? c.decode(Bool.self, forKey: .replayed)) ?? false)
            } else { payload = .none }
        case "turn.completed":
            payload = .turnCompleted(
                resultText: (try? c.decode(String.self, forKey: .resultText)) ?? "",
                usage: try? c.decodeIfPresent(UsageSnapshot.self, forKey: .usage)
            )
        case "turn.failed":
            payload = .turnFailed(
                code: (try? c.decode(String.self, forKey: .code)) ?? "internal_error",
                message: (try? c.decode(String.self, forKey: .message)) ?? ""
            )
        case "turn.stopped":
            payload = .turnStopped(reason: try? c.decodeIfPresent(String.self, forKey: .reason))
        case "turn.plan.updated":
            payload = (try? c.decode(Item.self, forKey: .item)).map { .turnPlanUpdated(item: $0) } ?? .none
        case "item.started":
            payload = (try? c.decode(Item.self, forKey: .item)).map { .itemStarted(item: $0) } ?? .none
        case "item.updated":
            payload = (try? c.decode(Item.self, forKey: .item)).map { .itemUpdated(item: $0) } ?? .none
        case "item.completed":
            payload = (try? c.decode(Item.self, forKey: .item)).map { .itemCompleted(item: $0) } ?? .none
        case "content.delta":
            if let itemId = try? c.decode(EngineID.self, forKey: .itemId),
               let text = try? c.decode(String.self, forKey: .text) {
                payload = .contentDelta(
                    itemId: itemId,
                    stream: (try? c.decode(ContentStream.self, forKey: .stream)) ?? .unknown,
                    text: text
                )
            } else { payload = .none }
        case "request.opened":
            payload = (try? c.decode(EngineRequest.self, forKey: .request)).map { .requestOpened(request: $0) } ?? .none
        case "request.resolved":
            if let requestId = try? c.decode(EngineID.self, forKey: .requestId) {
                payload = .requestResolved(requestId: requestId, decision: try? c.decodeIfPresent(RequestDecision.self, forKey: .decision))
            } else { payload = .none }
        case "task.started":
            payload = (try? c.decode(AgentTask.self, forKey: .task)).map { .taskStarted(task: $0) } ?? .none
        case "task.progress":
            payload = (try? c.decode(AgentTask.self, forKey: .task)).map { .taskProgress(task: $0) } ?? .none
        case "task.completed":
            payload = (try? c.decode(AgentTask.self, forKey: .task)).map { .taskCompleted(task: $0) } ?? .none
        case "session.updated":
            payload = (try? c.decode(Session.self, forKey: .session)).map { .sessionUpdated(session: $0) } ?? .none
        case "usage.updated":
            payload = (try? c.decode(UsageSnapshot.self, forKey: .usage)).map { .usageUpdated(usage: $0) } ?? .none
        case "browser.control.changed":
            payload = (try? c.decode(String.self, forKey: .controller)).map { .browserControlChanged(controller: $0) } ?? .none
        case "display.opened":
            payload = (try? c.decode(String.self, forKey: .path)).map { .displayOpened(path: $0, title: try? c.decodeIfPresent(String.self, forKey: .title)) } ?? .none
        case "kernel.state.changed":
            // An unrecognised state already decodes to `.unknown`, so a newer
            // engine's vocabulary still moves the revision.
            payload = (try? c.decode(KernelState.self, forKey: .state))
                .map { .kernelStateChanged(state: $0, reason: try? c.decodeIfPresent(String.self, forKey: .reason)) } ?? .none
        case "notebook.cell.output":
            // The OUTPUT is optional: a body this build cannot read is still
            // an execution that happened, and the revision it bumps is what
            // makes the surface re-read.
            payload = (try? c.decode(String.self, forKey: .execId)).map {
                .notebookCellOutput(
                    execId: $0,
                    cellId: try? c.decodeIfPresent(String.self, forKey: .cellId),
                    producer: try? c.decodeIfPresent(String.self, forKey: .producer),
                    output: try? c.decodeIfPresent(CellOutput.self, forKey: .output)
                )
            } ?? .none
        default:
            payload = .none
        }
    }
}

/// A page of journal rows plus the cursor to resume from.
struct EventPage: Decodable {
    var events: [EngineEvent]
    /// The highest id in `events`, repeated by the server so a client need
    /// not scan for it — and so skipped rows cannot stall replay.
    var cursor: Int
    var more: Bool
    /// The `after` for the next page, sent exactly when `more` is true (#494).
    /// It equals `cursor`; a client that pages may read either, and one that
    /// only tails stores `cursor` and ignores this. Absent from an engine older
    /// than the paged route, where `more` was always false.
    var next: Int?

    private enum CodingKeys: String, CodingKey { case events, cursor, more, next }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        events = try c.decode([Skippable<EngineEvent>].self, forKey: .events).compactMap(\.value)
        cursor = try c.decode(Int.self, forKey: .cursor)
        more = try c.decodeIfPresent(Bool.self, forKey: .more) ?? false
        next = try c.decodeIfPresent(Int.self, forKey: .next)
    }
}

struct EngineHealth: Decodable {
    struct Worker: Decodable {
        var registered: Bool
        var workerId: EngineID?
    }
    var daemonId: EngineID
    var startedAt: Timestamp
    var worker: Worker
}

/// Mirror of `SnapshotPage` in packages/engine-client: where a windowed read
/// continues. `before` is JSON `null` once the page reaches the session's
/// start — decodeIfPresent maps both null and absent to nil, which is right,
/// because either way there is nothing above.
struct SnapshotPage: Decodable {
    /// Oldest settled turn on this page — the `before` for the next page up.
    var before: EngineID?
    /// Are there settled turns above this page?
    var more: Bool
}

/// `GET /api/sessions/:id` — snapshot plus everything the fold seeds from.
struct SessionSnapshot: Decodable {
    /// The journal position this snapshot reflects — where a client tails
    /// from. Absent from an engine older than the field.
    var cursor: Int?
    /// Present when the read was windowed (`?turns=N`); absent from an older
    /// engine or an unwindowed read.
    var page: SnapshotPage?
    var session: Session
    var turns: [Turn]
    var items: [Item]
    var requests: [EngineRequest]
    var tasks: [AgentTask]

    private enum CodingKeys: String, CodingKey { case cursor, page, session, turns, items, requests, tasks }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cursor = try c.decodeIfPresent(Int.self, forKey: .cursor)
        page = try? c.decodeIfPresent(SnapshotPage.self, forKey: .page)
        session = try c.decode(Session.self, forKey: .session)
        // SKIPPABLE HIDES OUR OWN MISTAKES TOO. A row whose shape this build
        // does not know is meant to drop; a row whose field WE declared with
        // the wrong type drops identically and just as quietly. Before
        // changing a type here, read the note on `Skippable`.
        turns = try c.decode([Skippable<Turn>].self, forKey: .turns).compactMap(\.value)
        items = try c.decode([Skippable<Item>].self, forKey: .items).compactMap(\.value)
        requests = try c.decode([Skippable<EngineRequest>].self, forKey: .requests).compactMap(\.value)
        tasks = try c.decode([Skippable<AgentTask>].self, forKey: .tasks).compactMap(\.value)
    }
}
