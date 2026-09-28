import SwiftUI

struct TranscriptView: View {
    let turns: [JournalTurn]

    var receiptMarker: EngineID?

    var onReceiptMarkerVisible: ((EngineID, Bool) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(groupNotificationTurns(turns).map(TurnGroup.init)) { group in
                VStack(alignment: .leading, spacing: group.turns.count > 1 ? 2 : 16) {
                    ForEach(group.turns) { turn in
                        TurnView(turn: turn)
                        if let receiptMarker, turn.runId == receiptMarker, let onReceiptMarkerVisible {
                            ReadReceiptMarker(runId: receiptMarker, onVisible: onReceiptMarkerVisible)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 12)
    }
}

private struct TurnGroup: Identifiable {
    let turns: [JournalTurn]
    init(_ turns: [JournalTurn]) { self.turns = turns }
    var id: EngineID { turns.first?.runId ?? "" }
}

struct ReadReceiptMarker: View {
    let runId: EngineID
    let onVisible: (EngineID, Bool) -> Void

    var body: some View {
        Color.clear
            .frame(height: 1)
            .accessibilityHidden(true)
            .onScrollVisibilityChange { visible in onVisible(runId, visible) }
            .id(runId)
    }
}

struct TurnView: View {
    let turn: JournalTurn

    private func split(_ items: [JournalItem]) -> (activity: [JournalItem], closing: [JournalItem]) {
        let lastProse = items.lastIndex { item in
            if case .assistantMessage = item.detail { return true }
            return false
        }
        guard let lastProse else { return (items, []) }
        return (Array(items[..<lastProse]), Array(items[lastProse...]))
    }

    var body: some View {
        let responses = splitAtMessageBoundaries(withoutOpeningNotification(turn))
        let answering = responses[responses.count - 1]
        let earlier = responses.dropLast()
        let orphans = spawnlessTasks(turn.items, tasks: turn.tasks)
        let (activity, closing) = split(answering.items)

        if turn.isCompactGesture {
            VStack(alignment: .leading, spacing: 6) {
                let compactions = turn.items.filter { item in
                    if case .contextCompaction = item.detail { return true }
                    return false
                }
                if compactions.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.down.right.and.arrow.up.left")
                            .font(.system(Theme.caption))
                        Text(turn.state.isActive ? "Compacting context…" : turn.state == .failed ? "Compaction failed" : "Context compaction requested")
                            .font(.system(Theme.footnote))
                    }
                    .foregroundStyle(turn.state == .failed ? Theme.statusRed : Theme.textMuted)
                } else {
                    ForEach(compactions) { item in
                        ItemRowView(item: item)
                    }
                }
            }
        } else {
        VStack(alignment: .leading, spacing: 10) {
            if turn.notification != nil {
                NotificationTurnRow(turn: turn)
            } else if turn.isWake || turn.isProviderStarted {
                WakeRow(turn: turn)
            } else if turn.isFromAgent {
                AgentMessageRow(turn: turn)
            } else {
                UserBubble(text: turn.prompt)
            }

            ForEach(Array(earlier.enumerated()), id: \.element.boundary?.id) { _, response in
                if let boundary = response.boundary {
                    ItemRowView(item: boundary)
                }
                LiveActivityView(items: response.items, tasks: turn.tasks, liveTail: false)
            }
            if let boundary = answering.boundary {
                ItemRowView(item: boundary)
            }

            if turn.state.isActive {
                LiveActivityView(items: answering.items, tasks: turn.tasks, orphans: orphans)
            } else {
                ActivityGroupView(items: activity, tasks: turn.tasks, live: false)
                ForEach(closing) { item in
                    ItemRowView(item: item)
                }
                ForEach(orphans) { task in
                    TaskRowView(task: task)
                }
            }
            switch turn.state {
            case .failed:

                Text(turn.failure ?? "Turn failed")
                    .font(Theme.meta)
                    .foregroundStyle(Theme.statusRed)
            case .stopped:
                Text("Stopped")
                    .font(Theme.meta)
                    .foregroundStyle(Theme.textMuted)
            case .running, .claimed, .queued, .steering:
                WorkingIndicator(turn: turn)
            default:
                EmptyView()
            }
        }
        }
    }
}

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

enum TurnRenderEntry: Equatable {
    case boundary(JournalItem)
    case work([JournalItem])
}

func turnRenderOrder(_ items: [JournalItem]) -> [TurnRenderEntry] {
    splitAtMessageBoundaries(items).flatMap { response -> [TurnRenderEntry] in
        var out: [TurnRenderEntry] = []
        if let boundary = response.boundary { out.append(.boundary(boundary)) }
        if !response.items.isEmpty { out.append(.work(response.items)) }
        return out
    }
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

struct LiveActivityView: View {
    let items: [JournalItem]
    let tasks: [JournalTask]

    var liveTail = true

    var orphans: [JournalTask] = []

    var body: some View {
        let segments = segmentActivity(items)
        let tail = segments.indices.last
        ForEach(Array(segments.enumerated()), id: \.element.id) { index, segment in
            switch segment {
            case .row(let item):
                ItemRowView(item: item)
            case .run(let run):
                ActivityGroupView(items: run, tasks: tasks, live: liveTail && index == tail)
            }
        }
        ForEach(orphans) { task in
            TaskRowView(task: task)
        }
    }
}

struct ActivityGroupView: View {
    let items: [JournalItem]

    let tasks: [JournalTask]
    let live: Bool

    var body: some View {
        let rows = renderable(items, tasks: tasks)
        if !rows.isEmpty {
            let cuts = cutAroundLiveAgents(rows, tasks: tasks)

            let lastRun = cuts.lastIndex { if case .run = $0 { return true } else { return false } }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(cuts.enumerated()), id: \.element.id) { index, cut in
                    switch cut {
                    case .agent(let item):

                        TaskChipRow(item: item, tasks: tasks)
                    case .run(let run):
                        ActivityRunView(rows: run, tasks: tasks, live: live && index == lastRun)
                    }
                }
            }
        }
    }
}

struct TaskChipRow: View {
    let item: JournalItem
    let tasks: [JournalTask]

    var body: some View {
        if case .task(let taskId) = item.detail, let task = tasks.first(where: { $0.id == taskId }) {
            TaskRowView(task: task)
        } else {
            ToolChipLabel(icon: "person.2", label: item.label, status: item.status)
        }
    }
}

struct StepFoldView<Row: Identifiable, Content: View>: View {
    private let rows: [Row]
    private let live: Bool
    private let failed: (Row) -> Bool
    private let tally: () -> String
    private let content: (Row) -> Content
    @State private var expanded = false

    init(
        rows: [Row],
        live: Bool,
        failed: @escaping (Row) -> Bool,
        tally: @escaping () -> String,
        @ViewBuilder content: @escaping (Row) -> Content
    ) {
        self.rows = rows
        self.live = live
        self.failed = failed
        self.tally = tally
        self.content = content
    }

    private var anyFailed: Bool { rows.contains(where: failed) }

    var body: some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                if live {
                    liveWindow
                } else {
                    settledFold
                }
            }
        }
    }

    @ViewBuilder private var liveWindow: some View {
        let hidden = max(0, rows.count - 1)
        if hidden > 0 {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    chevron
                    if !expanded && anyFailed { failureGlyph }
                    Text(expanded ? "Show fewer steps" : "+\(hidden) earlier step\(hidden == 1 ? "" : "s")")
                        .font(Theme.meta)
                        .foregroundStyle(!expanded && anyFailed ? Theme.statusRed : Theme.textMuted)
                }
                .frame(minHeight: 24)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        ForEach(expanded ? rows : Array(rows.suffix(1))) { item in
            content(item)
        }
    }

    @ViewBuilder private var settledFold: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
        } label: {
            HStack(spacing: 6) {
                chevron
                if !expanded && anyFailed { failureGlyph }
                Text("\(rows.count) step\(rows.count == 1 ? "" : "s")")
                    .font(Theme.meta)
                    .foregroundStyle(!expanded && anyFailed ? Theme.statusRed : Theme.textMuted)
                    .tabularNumbers()
                Text("·").foregroundStyle(Theme.textMuted.opacity(0.5))
                Text(tally())
                    .font(Theme.meta)
                    .foregroundStyle(Theme.textMuted.opacity(0.8))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 24)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        if expanded {
            NestedDetail {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(rows) { item in
                        content(item)
                    }
                }
            }
        }
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.system(Theme.caption, weight: .semibold))
            .foregroundStyle(Theme.textMuted.opacity(0.6))
            .rotationEffect(.degrees(expanded ? 90 : 0))
    }

    private var failureGlyph: some View {
        Image(systemName: "exclamationmark.triangle")
            .font(.system(Theme.caption, weight: .medium))
            .foregroundStyle(Theme.statusRed)
    }
}

struct ActivityRunView: View {
    let rows: [JournalItem]
    let tasks: [JournalTask]
    let live: Bool

    var body: some View {
        StepFoldView(rows: rows, live: live, failed: failed, tally: { tally }) { item in
            row(item)
        }
    }

    private func failed(_ item: JournalItem) -> Bool {
        if item.status == .failed { return true }
        guard case .task(let taskId) = item.detail else { return false }
        return tasks.first(where: { $0.id == taskId })?.task.state == .failed
    }

    @ViewBuilder private func row(_ item: JournalItem) -> some View {
        if case .task = item.detail {
            TaskChipRow(item: item, tasks: tasks)
        } else {
            ItemRowView(item: item)
        }
    }

    private var tally: String {
        var order: [String] = []
        var counts: [String: Int] = [:]
        for item in rows {
            let label = tallyLabel(item)
            if counts[label] == nil { order.append(label) }
            counts[label, default: 0] += 1
        }
        return order.map { label in
            let count = counts[label]!
            return count > 1 ? "\(label) ×\(count)" : label
        }.joined(separator: " · ")
    }

    private func tallyLabel(_ item: JournalItem) -> String {
        switch item.detail {
        case .assistantMessage: "Narrated"
        case .commandExecution: "Ran command"
        case .fileChange: "Edited file"
        case .fileRead: "Read file"
        case .webSearch: "Searched"
        case .browserAction: "Browser"
        case .reasoning: "Thought"

        case .notification(let detail): describeNotification(detail)
        case .userMessage(let message):
            message.wakeReason != nil ? "Woken" : message.sender != nil ? "Agent message" : "You steered"
        case .task: "Delegated"
        case .error: "Error"
        case .plan: "Planned"
        case .contextCompaction: "Compacted context"
        case .mcpToolCall(let call), .dynamicToolCall(let call): displayToolName(call.name)
        default: item.label
        }
    }
}

func noticeFirstLine(_ notice: String) -> String {
    notice.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
        .first.map(String.init) ?? notice
}

struct AgentNoticeRow: View {
    let senderLabel: String

    var intent: String?

    var notice: String?

    let message: String
    var scope: String?
    @State private var open = false

    private var summary: String {
        if let notice, !notice.isEmpty { return noticeFirstLine(notice) }
        return message.split(separator: "\n").first.map(String.init) ?? message
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.left.arrow.right")
                        .font(.system(Theme.caption)).foregroundStyle(Theme.textMuted)
                    Text(intent.map { $0.capitalized } ?? "Agent message")
                        .font(Theme.meta).foregroundStyle(Theme.textMuted)
                    Text(summary)
                        .font(Theme.meta).foregroundStyle(Theme.textMuted)
                        .lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 4)
                    if let scope, !scope.isEmpty {
                        Text(scope).font(Theme.metaSmall).foregroundStyle(Theme.textMuted).lineLimit(1)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(Theme.caption, weight: .semibold))
                        .foregroundStyle(Theme.textMuted.opacity(0.6))
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .frame(minHeight: 30)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Message from another agent")
            .accessibilityHint(senderLabel)
            if open {
                NestedDetail {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(senderLabel)
                                .font(Theme.monoSmall).foregroundStyle(Theme.textMuted)
                            MarkdownText(text: message)
                        }
                    }
                    .frame(maxHeight: 240)
                }
            }
        }
    }
}

struct AgentMessageRow: View {
    let turn: JournalTurn

    var body: some View {
        AgentNoticeRow(
            senderLabel: agentSenderLabel(turn.sender),
            intent: turn.agentIntent,
            notice: turn.agentNotice,
            message: turn.prompt,
            scope: turn.assignmentScope
        )
    }
}

struct WakeRow: View {
    let line: String

    var head: String?

    init(line: String, head: String? = nil) {
        self.line = line
        self.head = head
    }

    init(turn: JournalTurn) {
        line = turn.isProviderStarted ? describeProviderWake(turn.providerReason) : describeWake(turn.wakeReason)
        head = notificationHead(turn.agentNotice) ?? notificationHead(turn.prompt)
    }

    init(message: UserMessageDetail) {
        line = describeWake(message.wakeReason)
        head = notificationHead(message.notice) ?? notificationHead(message.text)
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "bell").font(.system(Theme.caption))
            Text(line)
                .font(Theme.meta)
                .lineLimit(2)
            if let head, head != line {
                Text(head).font(Theme.monoSmall).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(Theme.textMuted)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Woken: \(line)")
    }
}

func describeNotification(_ detail: NotificationDetail) -> String {
    notificationVerb(kind: detail.kind, intent: detail.intent, wakeKind: detail.wakeKind)
}

func describeNotificationHead(_ detail: NotificationDetail, message: String? = nil) -> String? {
    guard detail.kind == "peer_message" else { return nil }
    return notificationHead(message ?? detail.summary)
}

struct NotificationRow: View {
    let detail: NotificationDetail

    var message: String? = nil
    @State private var expanded = false
    @State private var reading = false

    private var peerMessage: String? {
        guard detail.kind == "peer_message", let message, !message.isEmpty, message != detail.body else { return nil }
        return message
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "bell").font(.system(Theme.caption))
                    Text(describeNotification(detail)).font(Theme.meta)

                    if let head = describeNotificationHead(detail, message: message) {
                        Text(head).font(Theme.monoSmall).lineLimit(1)
                    }
                    if let entries = detail.entries, entries.count > 1 {
                        Text("and \(entries.count - 1) more").font(Theme.monoSmall)
                    }
                    if let sessionId = detail.sessionId {
                        Text("session …\(String(sessionId.suffix(6)))").font(Theme.monoSmall)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(Theme.caption))
                }
                .foregroundStyle(Theme.textMuted)

                .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                NestedDetail {
                    VStack(alignment: .leading, spacing: 6) {
                        if let entries = detail.entries, entries.count > 1 {
                            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                                Text(entry.summary).font(Theme.monoSmall).foregroundStyle(Theme.textMuted).lineLimit(2)
                            }
                        }
                        Text(detail.body)
                            .font(Theme.meta)
                            .foregroundStyle(Theme.textMuted)
                            .textSelection(.enabled)

                        if let peerMessage {
                            Button(reading ? "Hide the message" : "Read the message") {
                                withAnimation(.easeInOut(duration: 0.2)) { reading.toggle() }
                            }
                            .font(Theme.monoSmall)
                            .buttonStyle(.plain)
                            .foregroundStyle(Theme.textMuted)
                            if reading {
                                MarkdownText(text: peerMessage)
                            }
                        }
                    }
                    .frame(maxHeight: 240)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Notification: \(describeNotification(detail))")
    }
}

struct NotificationTurnRow: View {
    let turn: JournalTurn

    var body: some View {
        if let detail = turn.notification {
            NotificationRow(detail: detail, message: turn.sender != nil ? turn.prompt : nil)
        }
    }
}

struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 24)
            Group {
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Label("Image", systemImage: "photo")
                        .foregroundStyle(Theme.textMuted)
                } else {
                    Text(text)
                        .lineSpacing(4)
                        .foregroundStyle(Theme.text)
                }
            }
            .font(Theme.body)
            .padding(12)
            .background(Theme.messageSurface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusBubble))
            .frame(maxWidth: .infinity, alignment: .trailing)
            .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct WorkingIndicator: View {
    let turn: JournalTurn

    private var label: String {
        if turn.isCompacting { return "Compacting context" }
        return turn.state == .queued ? "Queued" : "Working"
    }

    var body: some View {
        HStack(spacing: 8) {
            SteppedPulseDot(color: Theme.statusSky)
            SweepingText(text: label)
        }
        .frame(minHeight: 24)
    }
}

struct SweepingText: View {
    let text: String
    @State private var phase: CGFloat = -1

    var body: some View {
        Text(text)
            .font(Theme.body)
            .foregroundStyle(Theme.textMuted)
            .overlay {
                GeometryReader { geo in
                    let sweep: CGFloat = 72
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: 0),
                            .init(color: Theme.text.opacity(0.9), location: 0.5),
                            .init(color: .clear, location: 1),
                        ],
                        startPoint: .leading, endPoint: .trailing
                    )
                    .frame(width: sweep)
                    .offset(x: phase * (geo.size.width + sweep) - sweep)
                }
                .mask(Text(text).font(Theme.body))
            }
            .onAppear {
                withAnimation(.linear(duration: 2.2).repeatForever(autoreverses: false)) {
                    phase = 1
                }
            }
    }
}

struct ItemRowView: View {
    let item: JournalItem
    @State private var showDetail = false
    @State private var reasoningExpanded = false

    var body: some View {
        switch item.detail {
        case .assistantMessage:

            StreamingMarkdown(text: item.text, streaming: item.status == .inProgress)
        case .notification(let detail):

            NotificationRow(detail: detail)
        case .userMessage(let message):

            if message.wakeReason != nil {
                WakeRow(message: message)
            } else if let sender = message.sender {
                AgentNoticeRow(senderLabel: agentSenderLabel(sender), notice: message.notice, message: item.text)
            } else {
                UserBubble(text: item.text)
            }
        case .reasoning:
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { reasoningExpanded.toggle() }
            } label: {
                VStack(alignment: .leading, spacing: 6) {
                    ToolChipLabel(icon: "brain", label: "Thought", status: nil)
                    if reasoningExpanded {
                        NestedDetail {
                            Text(item.text)
                                .font(Theme.meta)
                                .foregroundStyle(Theme.textMuted)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            .buttonStyle(.plain)
        case .plan(let plan):
            NestedDetail {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(Array(plan.steps.enumerated()), id: \.offset) { _, step in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: step.status == .completed ? "checkmark.circle.fill"
                                  : step.status == .inProgress ? "circle.dotted.circle" : "circle")
                                .font(.system(Theme.footnote))
                                .foregroundStyle(step.status == .completed ? Theme.statusEmerald : Theme.textMuted)
                            Text(step.step)
                                .font(Theme.meta)
                                .foregroundStyle(step.status == .completed ? Theme.textMuted : Theme.text)
                                .strikethrough(step.status == .completed, color: Theme.textMuted)
                        }
                    }
                }
            }
        case .error(let error):
            Text(error.message)
                .font(Theme.meta)
                .foregroundStyle(Theme.statusRed)
        case .contextCompaction(_, let pre, let post):
            HStack(spacing: 8) {
                Rectangle().fill(Theme.border).frame(height: 1)
                Text(compactionLabel(pre: pre, post: post))
                    .font(Theme.metaSmall)
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize()
                Rectangle().fill(Theme.border).frame(height: 1)
            }
        case .task:

            EmptyView()
        case .unknown(let label):
            ToolChipLabel(icon: "questionmark.diamond", label: label ?? "unknown item", status: item.status)
        default:
            Button {
                showDetail = true
            } label: {
                ToolChipLabel(icon: toolIcon, label: item.label, status: item.status)
            }
            .buttonStyle(.plain)
            .sheet(isPresented: $showDetail) {
                ToolDetailSheet(item: item)
            }
            .contextMenu { rowMenu }
        }
    }

    @Environment(\.panel) private var panel

    @ViewBuilder private var rowMenu: some View {
        if let command = item.rowCommand {
            Button("Copy command", systemImage: "doc.on.doc") { UIPasteboard.general.string = command }
        }
        if let body = item.rowBody {
            Button(item.rowBodyIsPatch ? "Copy patch" : "Copy output", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = body
            }
        }
        if let path = item.rowPath {
            Divider()

            if let panel, openablePath != nil {
                Button("Open file in the Editor", systemImage: "sidebar.trailing") { panel.openFile(path) }
            }
            Button("Copy path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
            if let panel {
                Button("Insert as reference", systemImage: "text.badge.plus") {
                    panel.insertReference(ComposerReference.file(path))
                }
            }
        }
    }

    private var openablePath: String? {
        switch item.detail {
        case .fileChange(let change): change.kind == "delete" ? nil : change.path
        case .fileRead(let read): read.path
        default: nil
        }
    }

    private var toolIcon: String {
        switch item.detail {
        case .commandExecution: "terminal"
        case .fileChange: "pencil.line"
        case .fileRead: "doc.text"
        case .webSearch: "magnifyingglass"
        case .browserAction: "globe"
        default: "wrench.and.screwdriver"
        }
    }

    private func compactionLabel(pre: Int?, post: Int?) -> String {
        if let pre, let post {
            return "Context compacted \(pre / 1000)k → \(post / 1000)k"
        }
        return "Context compacted"
    }
}

struct ToolChipLabel: View {
    let icon: String
    let label: String
    let status: ItemStatus?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(Theme.footnote, weight: .medium))
                .foregroundStyle(Theme.textMuted)
                .opacity(0.7)
                .frame(width: 24, height: 24)
            Text(label)
                .font(Theme.mono)
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
            statusGlyph
            Spacer(minLength: 0)
        }
        .frame(minHeight: 24)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var statusGlyph: some View {
        switch status {
        case .inProgress:
            SteppedPulseDot(color: Theme.statusSky)
        case .failed:
            Image(systemName: "xmark").font(.system(Theme.caption, weight: .semibold)).foregroundStyle(Theme.statusRed)
        case .declined:
            Image(systemName: "hand.raised").font(.system(Theme.caption)).foregroundStyle(Theme.statusAmber)
        default:
            EmptyView()
        }
    }
}

struct NestedDetail<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Rectangle()
                .fill(Theme.border)
                .frame(width: 1)
                .padding(.leading, 12)
            content
        }
        .padding(.top, 2)
    }
}

struct TaskRowView: View {
    let task: JournalTask
    @State private var showDetail = false

    var body: some View {
        Button {
            showDetail = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "person.2")
                    .font(.system(Theme.footnote, weight: .medium))
                    .foregroundStyle(Theme.textMuted)
                    .opacity(0.7)
                    .frame(width: 24, height: 24)
                Text(task.task.title ?? "Sub-agent")
                    .font(Theme.body)
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                if task.task.state.isLive {
                    SteppedPulseDot(color: Theme.statusSky)
                } else if task.task.state == .failed {
                    Image(systemName: "xmark").font(.system(Theme.caption, weight: .semibold)).foregroundStyle(Theme.statusRed)
                }
                Text("\(task.items.count) step\(task.items.count == 1 ? "" : "s")")
                    .font(Theme.metaSmall)
                    .foregroundStyle(Theme.textMuted.opacity(0.7))
                    .tabularNumbers()
                Image(systemName: "chevron.right")
                    .font(.system(Theme.captionTiny, weight: .semibold))
                    .foregroundStyle(Theme.textMuted.opacity(0.5))
                Spacer(minLength: 0)
            }
            .frame(minHeight: 24)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showDetail) {
            AgentDetailSheet(task: task)
        }
    }
}

struct AgentDetailSheet: View {
    let task: JournalTask
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        if task.task.state.isLive {
                            SteppedPulseDot(color: Theme.statusSky)
                            Text("Working")
                                .font(Theme.meta)
                                .foregroundStyle(Theme.statusSky)
                        } else if task.task.state == .failed {
                            Image(systemName: "xmark").font(.system(Theme.caption, weight: .semibold)).foregroundStyle(Theme.statusRed)
                            Text("Failed").font(Theme.meta).foregroundStyle(Theme.statusRed)
                        } else {
                            Image(systemName: "checkmark").font(.system(Theme.caption, weight: .medium)).foregroundStyle(Theme.statusEmerald)
                            Text("Done").font(Theme.meta).foregroundStyle(Theme.textMuted)
                        }
                        Spacer(minLength: 0)
                    }
                    ForEach(task.items) { item in
                        ItemRowView(item: item)
                    }
                    if task.items.isEmpty {
                        Text("No steps recorded yet.")
                            .font(Theme.meta)
                            .foregroundStyle(Theme.textMuted)
                    }
                    if let result = task.task.resultText, !result.isEmpty {
                        Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 4)
                        MarkdownText(text: result)
                    }
                }
                .padding()
            }
            .background(Theme.canvas)
            .navigationTitle(task.task.title ?? "Sub-agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct ToolDetailSheet: View {
    let item: JournalItem
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    switch item.detail {
                    case .commandExecution(let command):
                        if let cwd = command.cwd {
                            Text(cwd).font(Theme.monoSmall).foregroundStyle(Theme.textMuted.opacity(0.7))
                        }
                        CodeBlockView(code: command.command)
                        if let exit = command.exitCode {
                            Text("exit \(exit)")
                                .font(Theme.meta)
                                .tabularNumbers()
                                .foregroundStyle(exit == 0 ? Theme.textMuted : Theme.statusRed)
                        }
                    case .fileChange(let change):
                        Text("\(change.kind) · \(change.path)")
                            .font(Theme.meta)
                            .foregroundStyle(Theme.textMuted)
                        if let diff = change.unifiedDiff {
                            CodeBlockView(code: diff)
                        }
                    case .fileRead(let read):
                        Text(read.path).font(Theme.mono).foregroundStyle(Theme.text)
                    case .mcpToolCall(let call), .dynamicToolCall(let call), .browserAction(let call, _):
                        if let input = call.input {
                            Text("Input").font(Theme.metaSmall).foregroundStyle(Theme.textMuted)
                            CodeBlockView(code: input.prettyPrinted)
                        }
                    case .webSearch(let query, let count):
                        Text(query).font(Theme.body)
                        if let count {
                            Text("\(count) results").font(Theme.meta).foregroundStyle(Theme.textMuted).tabularNumbers()
                        }
                    default:
                        EmptyView()
                    }
                    let streamed = item.streamedText
                    let output = streamed.isEmpty ? item.toolOutput : streamed
                    if let output, !output.isEmpty {
                        Text("Output").font(Theme.metaSmall).foregroundStyle(Theme.textMuted)
                        CodeBlockView(code: output)
                    }
                }
                .padding()
            }
            .background(Theme.canvas)
            .navigationTitle(item.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
