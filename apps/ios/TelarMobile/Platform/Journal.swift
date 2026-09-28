import Foundation

struct JournalItem: Identifiable, Equatable {
    var item: Item

    var streamedText: String

    var openedBy: Int

    var id: EngineID { item.id }
    var status: ItemStatus { item.status }
    var detail: ItemDetail { item.detail }

    var text: String {
        if !streamedText.isEmpty { return streamedText }
        switch item.detail {
        case .assistantMessage(let text), .reasoning(let text):
            return text
        case .userMessage(let message):
            return message.text
        case .notification(let detail):
            return detail.body
        default:
            return ""
        }
    }

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
        case .notification(let detail): return detail.summary
        case .userMessage: return "user_message"
        case .assistantMessage: return "assistant_message"
        case .reasoning: return "reasoning"
        case .plan: return "plan"
        case .task: return "task"
        case .contextCompaction: return "context_compaction"
        }
    }

    var rowPath: String? {
        switch item.detail {
        case .fileChange(let change): return change.path
        case .fileRead(let read): return read.path
        default: return nil
        }
    }

    var rowCommand: String? {
        guard case .commandExecution(let command) = item.detail, !command.command.isEmpty else { return nil }
        return command.command
    }

    var rowBody: String? {
        if case .fileChange(let change) = item.detail, let diff = change.unifiedDiff { return diff }
        let output = streamedText.isEmpty ? toolOutput : streamedText
        guard let output, !output.isEmpty else { return nil }
        return output
    }

    var rowBodyIsPatch: Bool {
        guard case .fileChange(let change) = item.detail else { return false }
        return change.unifiedDiff != nil
    }

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

    var sequence: Int = 0
    var prompt: String

    var isCompactGesture: Bool = false
    var state: TurnState

    var items: [JournalItem]
    var tasks: [JournalTask]
    var startedAt: Timestamp?

    var lastActivityAt: Timestamp?
    var resultText: String
    var failure: String?
    var usage: UsageSnapshot?

    var origin: String?
    var sender: MessageSender?
    var agentIntent: String?
    var assignmentScope: String?
    var wakeReason: WakeReason?
    var agentNotice: String?

    var notification: NotificationDetail?
    var providerReason: ProviderReason?

    var id: EngineID { runId }

    var isFromAgent: Bool { origin == "session" && wakeReason == nil }

    var isWake: Bool { wakeReason != nil && origin != "user" }

    var isProviderStarted: Bool { origin == "provider" }

    var isBackgroundClaim: Bool { providerReason?.kind == "background_task" }

    var isCompacting: Bool {
        items.contains { item in
            if case .contextCompaction = item.detail { return item.status == .inProgress }
            return false
        }
    }
}

func transcriptTurns(_ turns: [JournalTurn]) -> [JournalTurn] {
    turns.filter {
        $0.state != .queued && $0.state != .steering && $0.state != .steered && !$0.isBackgroundClaim
    }
}

func displayToolName(_ name: String) -> String {
    guard name.hasPrefix("mcp__") else { return name }
    let parts = name.split(separator: "__", omittingEmptySubsequences: false).map(String.init)
    guard parts.count >= 3, !parts[1].isEmpty else { return name }
    return parts.dropFirst(2).joined(separator: "__")
}

func appendJournalEvents(_ existing: [EngineEvent], _ incoming: [EngineEvent]) -> [EngineEvent] {
    var byId = [Int: EngineEvent]()
    for event in existing { byId[event.id] = event }
    for event in incoming { byId[event.id] = event }
    return byId.values.sorted { $0.id < $1.id }
}

func journalCursor(_ events: [EngineEvent]) -> Int {
    events.reduce(0) { max($0, $1.id) }
}

private final class ItemBox {
    var item: Item
    var streamedText = ""
    var streamedThrough: Int?
    var openedBy: Int
    init(item: Item, openedBy: Int) {
        self.item = item
        self.streamedText = item.streamed ?? ""
        self.streamedThrough = item.streamedThrough
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
    var sequence: Int
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
    var origin: String?
    var sender: MessageSender?
    var agentIntent: String?
    var assignmentScope: String?
    var wakeReason: WakeReason?
    var agentNotice: String?

    var notification: NotificationDetail?
    var providerReason: ProviderReason?
    init(turn: Turn) {
        runId = turn.runId
        sequence = turn.sequence
        prompt = turn.input
        isCompactGesture = turn.kind == "compact"
        state = turn.state
        startedAt = turn.startedAt
        resultText = turn.resultText ?? ""
        failure = turn.failure?.message
        usage = turn.usage
        origin = turn.origin
        sender = turn.sender
        agentIntent = turn.agentIntent
        assignmentScope = turn.assignmentScope
        wakeReason = turn.wakeReason
        agentNotice = turn.agentNotice
        notification = turn.notification
        providerReason = turn.providerReason
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
            if let through = item.streamedThrough, through > (existing.streamedThrough ?? -1) {
                existing.streamedText = item.streamed ?? ""
                existing.streamedThrough = through
            } else if existing.streamedThrough == nil && existing.streamedText.isEmpty {
                existing.streamedText = item.streamed ?? ""
            }
            existing.item = item

            if let owner, !owner.items.contains(where: { $0 === existing }) {
                turn.items.removeAll { $0 === existing }
                owner.items.append(existing)
            }
        } else {
            let box = ItemBox(item: item, openedBy: openedBy)
            seenItems[item.id] = box

            if let owner { owner.items.append(box) } else { turn.items.append(box) }
        }
    }

    for task in tasks { upsertTask(task) }
    for item in items { upsert(item, openedBy: 0) }

    for runId in runOrder {
        guard let turn = byRun[runId] else { continue }
        var latest = turn.startedAt ?? 0
        for box in turn.items { latest = max(latest, box.item.completedAt ?? box.item.startedAt) }
        for box in turn.tasks { latest = max(latest, box.task.updatedAt) }
        if latest > 0 { turn.lastActivityAt = latest }
    }

    for event in events {
        let turn = event.runId.flatMap { byRun[$0] }

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

            if let held = seenItems[itemId], event.id > (held.streamedThrough ?? -1) {
                held.streamedText += text
                held.streamedThrough = event.id
            }
        case .taskStarted(let task), .taskProgress(let task), .taskCompleted(let task):
            upsertTask(task)
        case .usageUpdated(let usage):
            turn?.usage = usage
        case .browserControlChanged(let controller):

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
        case .requestOpened, .requestResolved, .sessionUpdated, .displayOpened,
             .kernelStateChanged, .notebookCellOutput:

            break
        case .none:

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
            sequence: turn.sequence,
            prompt: turn.prompt,
            isCompactGesture: turn.isCompactGesture,
            state: turn.state,
            items: turn.items.sorted(by: byOpen).map(materialize),
            tasks: sortedTasks.map { JournalTask(task: $0.task, items: $0.items.sorted(by: byOpen).map(materialize)) },
            startedAt: turn.startedAt,
            lastActivityAt: turn.lastActivityAt,
            resultText: turn.resultText,
            failure: turn.failure,
            usage: turn.usage,
            origin: turn.origin,
            sender: turn.sender,
            agentIntent: turn.agentIntent,
            assignmentScope: turn.assignmentScope,
            wakeReason: turn.wakeReason,
            agentNotice: turn.agentNotice,
            notification: turn.notification,
            providerReason: turn.providerReason
        )
    }
}
