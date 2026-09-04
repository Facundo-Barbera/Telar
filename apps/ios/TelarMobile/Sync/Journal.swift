import Foundation

/// Port of `apps/web/lib/engine/journal.ts` — the client-side fold over the
/// session's event journal. Like the web, the fold is RECOMPUTED from
/// (turns, items, events, tasks) rather than applied incrementally: the event
/// list is bounded per session, the recompute is the oracle the web tests pin,
/// and an incremental fold is a second implementation that can drift.
///
/// The TS fold leans on JS reference semantics — the object in `seenItems`
/// IS the object in the rendered list, so a delta append lands in both. The
/// Swift port keeps that with internal reference boxes and materialises value
/// types at the end.

struct JournalItem: Identifiable, Equatable {
    var item: Item
    /// Deltas accumulated in arrival order. Empty for items that never stream.
    var streamedText: String
    /// The event id that opened this item — the sort key, never timestamps:
    /// two events can share a millisecond; the id is monotonic by construction.
    var openedBy: Int

    var id: EngineID { item.id }
    var status: ItemStatus { item.status }
    var detail: ItemDetail { item.detail }

    /// Streamed deltas win over the stored detail while live — the engine only
    /// folds text into the item when it closes. Once closed the two agree.
    var text: String {
        if !streamedText.isEmpty { return streamedText }
        switch item.detail {
        case .assistantMessage(let text), .reasoning(let text), .userMessage(let text):
            return text
        default:
            return ""
        }
    }

    /// One-line label for a collapsed row, preferring what the engine stored —
    /// the engine owns collapsed-row labels; clients must not invent them.
    var label: String {
        if let title = item.title, !title.isEmpty { return title }
        switch item.detail {
        case .commandExecution(let command): return command.command.isEmpty ? "command" : command.command
        case .fileChange(let change): return change.path
        case .fileRead(let read): return read.path
        case .mcpToolCall(let call), .dynamicToolCall(let call): return displayToolName(call.name)
        case .browserAction(let call, _): return displayToolName(call.name)
        case .webSearch(let query, _): return query
        case .error(let error): return error.message
        case .unknown(let label): return label ?? "unknown"
        case .userMessage: return "user_message"
        case .assistantMessage: return "assistant_message"
        case .reasoning: return "reasoning"
        case .plan: return "plan"
        case .task: return "task"
        case .contextCompaction: return "context_compaction"
        }
    }

    /// The output body of a finished tool call, when it has one.
    var toolOutput: String? {
        switch item.detail {
        case .commandExecution(let command):
            return command.outputPreview
        case .mcpToolCall(let call), .dynamicToolCall(let call), .browserAction(let call, _):
            switch call.output {
            case .string(let text): return text
            case .none: return nil
            case .some(let value): return value.prettyPrinted
            }
        default:
            return nil
        }
    }
}

struct JournalTask: Identifiable, Equatable {
    var task: AgentTask
    var items: [JournalItem]
    var id: EngineID { task.id }
}

struct JournalTurn: Identifiable, Equatable {
    var runId: EngineID
    var prompt: String
    /// The compaction gesture — a system row, not a bubble.
    var isCompactGesture: Bool = false
    var state: TurnState
    /// The MAIN LOOP's timeline only — sub-agent rows live on `tasks`.
    var items: [JournalItem]
    var tasks: [JournalTask]
    var startedAt: Timestamp?
    /// When anything last happened — deltas included. What "gone quiet" is
    /// measured from; only a gap since the LAST event can tell slow from stuck.
    var lastActivityAt: Timestamp?
    var resultText: String
    var failure: String?
    var usage: UsageSnapshot?

    var id: EngineID { runId }

    /// An open `context_compaction` item — the provider squeezing right now.
    var isCompacting: Bool {
        items.contains { item in
            if case .contextCompaction = item.detail { return item.status == .inProgress }
            return false
        }
    }
}

/// Strips `mcp__server__` framing — addressing, not meaning. The rest-join
/// matters: `mcp__github__fetch__pr` names a tool called `fetch__pr`.
func displayToolName(_ name: String) -> String {
    guard name.hasPrefix("mcp__") else { return name }
    let parts = name.split(separator: "__", omittingEmptySubsequences: false).map(String.init)
    guard parts.count >= 3, !parts[1].isEmpty else { return name }
    return parts.dropFirst(2).joined(separator: "__")
}

/// Merges a cursor page without duplicating durable journal records.
func appendJournalEvents(_ existing: [EngineEvent], _ incoming: [EngineEvent]) -> [EngineEvent] {
    var byId = [Int: EngineEvent]()
    for event in existing { byId[event.id] = event }
    for event in incoming { byId[event.id] = event }
    return byId.values.sorted { $0.id < $1.id }
}

func journalCursor(_ events: [EngineEvent]) -> Int {
    events.reduce(0) { max($0, $1.id) }
}

// MARK: - the fold

private final class ItemBox {
    var item: Item
    var streamedText = ""
    var openedBy: Int
    init(item: Item, openedBy: Int) {
        self.item = item
        self.openedBy = openedBy
    }
}

private final class TaskBox {
    var task: AgentTask
    var items: [ItemBox] = []
    init(task: AgentTask) { self.task = task }
}

private final class TurnBox {
    var runId: EngineID
    var prompt: String
    var isCompactGesture: Bool
    var state: TurnState
    var items: [ItemBox] = []
    var tasks: [TaskBox] = []
    var startedAt: Timestamp?
    var lastActivityAt: Timestamp?
    var resultText: String
    var failure: String?
    var usage: UsageSnapshot?
    init(turn: Turn) {
        runId = turn.runId
        prompt = turn.input
        isCompactGesture = turn.kind == "compact"
        state = turn.state
        startedAt = turn.startedAt
        resultText = turn.resultText ?? ""
        failure = turn.failure?.message
        usage = turn.usage
    }
}

func projectJournal(
    turns: [Turn], items: [Item], events: [EngineEvent], tasks: [AgentTask] = []
) -> [JournalTurn] {
    var runOrder: [EngineID] = []
    var byRun = [EngineID: TurnBox]()
    for turn in turns where byRun[turn.runId] == nil {
        byRun[turn.runId] = TurnBox(turn: turn)
        runOrder.append(turn.runId)
    }
    var seenItems = [EngineID: ItemBox]()
    var seenTasks = [EngineID: TaskBox]()

    func upsertTask(_ task: AgentTask) {
        guard let turn = byRun[task.runId] else { return }
        if let existing = seenTasks[task.id] {
            // Items already collected survive: every task event repeats the
            // whole task, and a replace would empty the list each time.
            existing.task = task
        } else {
            let box = TaskBox(task: task)
            seenTasks[task.id] = box
            turn.tasks.append(box)
        }
    }

    func upsert(_ item: Item, openedBy: Int) {
        guard let turn = byRun[item.runId] else { return }
        let owner = item.taskId.flatMap { seenTasks[$0] }
        if let existing = seenItems[item.id] {
            existing.item = item
            // openedBy and streamedText survive item.updated/completed.
            // If the row was parked on the main timeline because its task had
            // not been met yet, move it home now (the web keeps a stale copy
            // and lets the next snapshot repair it; a move is the same repair
            // without the duplicate row).
            if let owner, !owner.items.contains(where: { $0 === existing }) {
                turn.items.removeAll { $0 === existing }
                owner.items.append(existing)
            }
        } else {
            let box = ItemBox(item: item, openedBy: openedBy)
            seenItems[item.id] = box
            // A row filed under a task the fold has not met stays on the MAIN
            // timeline rather than being dropped — an invisible row is worse
            // than a misplaced one.
            if let owner { owner.items.append(box) } else { turn.items.append(box) }
        }
    }

    // The snapshot first: opening a long session must not replay its journal.
    // openedBy 0 is not a real id, so snapshot rows sort before anything the
    // tail opens. Tasks BEFORE items, so sub-agent rows find their owner.
    for task in tasks { upsertTask(task) }
    for item in items { upsert(item, openedBy: 0) }
    // The quiet clock, seeded so a page opened onto a running turn does not
    // start by claiming it has been silent since it began.
    for runId in runOrder {
        guard let turn = byRun[runId] else { continue }
        var latest = turn.startedAt ?? 0
        for box in turn.items { latest = max(latest, box.item.completedAt ?? box.item.startedAt) }
        for box in turn.tasks { latest = max(latest, box.task.updatedAt) }
        if latest > 0 { turn.lastActivityAt = latest }
    }

    for event in events {
        let turn = event.runId.flatMap { byRun[$0] }
        // ANY event on the turn is activity, deltas included — item timestamps
        // do not move while text streams.
        if let turn { turn.lastActivityAt = max(turn.lastActivityAt ?? 0, event.at) }

        switch event.payload {
        case .turnAccepted(let accepted, _):
            if byRun[accepted.runId] == nil {
                byRun[accepted.runId] = TurnBox(turn: accepted)
                runOrder.append(accepted.runId)
            }
        case .turnCompleted(let resultText, let usage):
            guard let turn else { break }
            turn.state = .completed
            turn.resultText = resultText
            if let usage { turn.usage = usage }
        case .turnFailed(_, let message):
            guard let turn else { break }
            turn.state = .failed
            turn.failure = message
        case .turnStopped:
            turn?.state = .stopped
        case .itemStarted(let item), .itemUpdated(let item), .itemCompleted(let item):
            upsert(item, openedBy: event.id)
        case .turnPlanUpdated(let item):
            upsert(item, openedBy: event.id)
        case .contentDelta(let itemId, _, let text):
            // A delta for an unseen item is DROPPED, not buffered: the fold is
            // missing the row that opened it, and a placeholder would render a
            // message with no idea what kind of row it belongs to.
            seenItems[itemId]?.streamedText += text
        case .taskStarted(let task), .taskProgress(let task), .taskCompleted(let task):
            upsertTask(task)
        case .usageUpdated(let usage):
            turn?.usage = usage
        case .browserControlChanged(let controller):
            // The §6 marker row, mirrored from the web fold: a takeover lands
            // inside the turn it interrupted as a one-line unknown-detail row.
            // Between turns (no runId) the live badge is the story, not history.
            guard let runId = event.runId, controller != "idle" else { break }
            upsert(
                Item(
                    id: "control_\(event.id)",
                    runId: runId,
                    sessionId: event.sessionId,
                    status: .completed,
                    title: nil,
                    detail: .unknown(label: controller == "human" ? "You took the browser" : "The browser was handed back to the agent"),
                    startedAt: event.at,
                    completedAt: event.at,
                    taskId: nil
                ),
                openedBy: event.id
            )
        case .requestOpened, .requestResolved, .sessionUpdated:
            break
        case .none:
            // State transitions the payload enum does not carry ride the type
            // string — same outcomes as the web fold's switch arms.
            guard let turn else { break }
            switch event.type {
            case "turn.claimed": turn.state = .claimed
            case "turn.started":
                turn.state = .running
                turn.startedAt = turn.startedAt ?? event.at
            case "turn.requeued": turn.state = .queued
            case "turn.steering": turn.state = .steering
            case "turn.steered": turn.state = .steered
            case "turn.ambiguous": turn.state = .ambiguous
            case "turn.discarded": turn.state = .discarded
            default: break
            }
        }
    }

    func materialize(_ box: ItemBox) -> JournalItem {
        JournalItem(item: box.item, streamedText: box.streamedText, openedBy: box.openedBy)
    }
    let byOpen: (ItemBox, ItemBox) -> Bool = {
        ($0.openedBy, $0.item.startedAt) < ($1.openedBy, $1.item.startedAt)
    }
    return runOrder.compactMap { runId in
        guard let turn = byRun[runId] else { return nil }
        let sortedTasks = turn.tasks.sorted {
            ($0.task.startedAt, $0.task.id) < ($1.task.startedAt, $1.task.id)
        }
        return JournalTurn(
            runId: turn.runId,
            prompt: turn.prompt,
            isCompactGesture: turn.isCompactGesture,
            state: turn.state,
            items: turn.items.sorted(by: byOpen).map(materialize),
            tasks: sortedTasks.map { JournalTask(task: $0.task, items: $0.items.sorted(by: byOpen).map(materialize)) },
            startedAt: turn.startedAt,
            lastActivityAt: turn.lastActivityAt,
            resultText: turn.resultText,
            failure: turn.failure,
            usage: turn.usage
        )
    }
}
