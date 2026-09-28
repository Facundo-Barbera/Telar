import Foundation

enum ActivitySegment: Equatable, Identifiable {
    case run([JournalItem])
    case row(JournalItem)

    var id: EngineID {
        switch self {
        case .run(let items): items[0].id
        case .row(let item): item.id
        }
    }
}

func segmentActivity(_ items: [JournalItem]) -> [ActivitySegment] {
    var segments: [ActivitySegment] = []
    for item in items {
        switch item.detail {
        case .assistantMessage, .userMessage, .plan, .contextCompaction:
            segments.append(.row(item))
        default:
            if case .run(var run)? = segments.last {
                run.append(item)
                segments[segments.count - 1] = .run(run)
            } else {
                segments.append(.run([item]))
            }
        }
    }
    return segments
}

struct TurnResponse: Equatable {
    var boundary: JournalItem?
    var items: [JournalItem]
}

func withoutOpeningNotification(_ turn: JournalTurn) -> [JournalItem] {
    guard turn.notification != nil, turn.origin == "session" || turn.origin == "provider" else { return turn.items }
    let drawn = "notification_\(turn.runId)"
    return turn.items.filter { $0.id != drawn }
}

func bareNotificationTurn(_ turn: JournalTurn) -> Bool {
    guard turn.notification != nil else { return false }
    guard withoutOpeningNotification(turn).isEmpty else { return false }
    guard turn.resultText.isEmpty, turn.failure == nil, turn.usage == nil else { return false }
    guard !turn.state.isActive else { return false }
    return turn.state != .failed && turn.state != .stopped && turn.state != .discarded
}

func groupNotificationTurns(_ turns: [JournalTurn]) -> [[JournalTurn]] {
    var groups: [[JournalTurn]] = []
    for turn in turns {
        if let previous = groups.last?.last, turn.notification != nil, bareNotificationTurn(previous) {
            groups[groups.count - 1].append(turn)
        } else {
            groups.append([turn])
        }
    }
    return groups
}

func splitAtMessageBoundaries(_ items: [JournalItem]) -> [TurnResponse] {
    var responses: [TurnResponse] = [TurnResponse(boundary: nil, items: [])]
    for item in items {
        if case .userMessage = item.detail {
            responses.append(TurnResponse(boundary: item, items: []))
        } else if case .notification = item.detail {
            responses.append(TurnResponse(boundary: item, items: []))
        } else {
            responses[responses.count - 1].items.append(item)
        }
    }

    return responses.count > 1 && responses[0].items.isEmpty ? Array(responses.dropFirst()) : responses
}

func transcriptTasks(_ tasks: [JournalTask]) -> [JournalTask] {
    tasks.filter { $0.task.kind != .background }
}

func renderable(_ items: [JournalItem], tasks: [JournalTask] = []) -> [JournalItem] {
    items.filter { item in
        switch item.detail {
        case .task(let taskId):
            guard let task = tasks.first(where: { $0.id == taskId }) else { return true }
            return !transcriptTasks([task]).isEmpty
        case .reasoning:
            return !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        default:
            return true
        }
    }
}

enum ActivityCut: Equatable, Identifiable {
    case run([JournalItem])
    case agent(JournalItem)

    var id: EngineID {
        switch self {
        case .run(let items): items[0].id
        case .agent(let item): item.id
        }
    }
}

func cutAroundLiveAgents(_ items: [JournalItem], tasks: [JournalTask]) -> [ActivityCut] {
    var out: [ActivityCut] = []
    for item in items {
        var live = false
        if case .task(let taskId) = item.detail, let task = tasks.first(where: { $0.id == taskId }) {
            live = task.task.state.isLive
        }
        if live {
            out.append(.agent(item))
            continue
        }
        if case .run(var run)? = out.last {
            run.append(item)
            out[out.count - 1] = .run(run)
        } else {
            out.append(.run([item]))
        }
    }
    return out
}

func spawnlessTasks(_ items: [JournalItem], tasks: [JournalTask]) -> [JournalTask] {
    let spawned = Set(items.compactMap { item -> EngineID? in
        if case .task(let taskId) = item.detail { return taskId }
        return nil
    })
    return transcriptTasks(tasks).filter { !spawned.contains($0.id) }
}
