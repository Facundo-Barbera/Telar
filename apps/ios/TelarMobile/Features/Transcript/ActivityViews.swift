import SwiftUI

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
