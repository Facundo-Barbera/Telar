import SwiftUI

/// The transcript, wearing t3code's chat anatomy. The load-bearing asymmetry:
/// YOU get a bubble (right-aligned, 80% max width, 18pt radius, tinted
/// surface); THE AGENT gets bare full-width text. Tool calls are one-line
/// chips, not cards.
struct TranscriptView: View {
    let turns: [JournalTurn]

    var body: some View {
        // EAGER, not lazy. A LazyVStack only estimates the height of rows it
        // has not built, so "scroll to the bottom edge" resolves against a
        // fiction: on a long transcript it parked the viewport in a region
        // where nothing had been materialised and the screen came up BLANK.
        // A transcript is bounded (and PR 2 windows it further), so paying for
        // real heights up front is what makes the tail a real place.
        VStack(alignment: .leading, spacing: 16) {
            ForEach(turns) { turn in
                TurnView(turn: turn)
            }
        }
        .padding(.horizontal, 12)
    }
}

struct TurnView: View {
    let turn: JournalTurn

    /// The web cockpit's split (session-cockpit.tsx): a settled turn shows
    /// its ANSWER and folds everything that produced it, so history reads as
    /// conclusions. The split point is the LAST assistant message —
    /// narration in the middle folds with the work it narrates.
    private var split: (activity: [JournalItem], closing: [JournalItem]) {
        let lastProse = turn.items.lastIndex { item in
            if case .assistantMessage = item.detail { return true }
            return false
        }
        guard let lastProse else { return (turn.items, []) }
        return (Array(turn.items[..<lastProse]), Array(turn.items[lastProse...]))
    }

    var body: some View {
        let (activity, closing) = split
        // THE COMPACTION GESTURE IS NOT A MESSAGE: one quiet system line, and
        // the `context_compaction` row with the numbers when it arrived. The
        // web cockpit draws the same (SessionTurn).
        if turn.isCompactGesture {
            VStack(alignment: .leading, spacing: 6) {
                let compactions = turn.items.filter { item in
                    if case .contextCompaction = item.detail { return true }
                    return false
                }
                if compactions.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.down.right.and.arrow.up.left")
                            .font(.system(size: 11))
                        Text(turn.state.isActive ? "Compacting context…" : turn.state == .failed ? "Compaction failed" : "Context compaction requested")
                            .font(.system(size: 13))
                    }
                    .foregroundStyle(turn.state == .failed ? Theme.statusRed : Theme.textTertiary)
                } else {
                    ForEach(compactions) { item in
                        ItemRowView(item: item)
                    }
                }
            }
        } else {
        VStack(alignment: .leading, spacing: 10) {
            UserBubble(text: turn.prompt)
            // LIVE, THE WHOLE TIMELINE IS CUT AT ITS SEAMS — each run of work
            // folds to its tally as the agent moves past it. The prose split
            // is for a FINISHED turn: only then is the last message the answer.
            if turn.state.isActive {
                LiveActivityView(items: turn.items, tasks: turn.tasks)
            } else {
                ActivityGroupView(items: activity, tasks: turn.tasks, live: false)
                ForEach(closing) { item in
                    ItemRowView(item: item)
                }
            }
            switch turn.state {
            case .failed:
                // t3code renders turn errors as a bare destructive line, not
                // an alert box.
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

/// A live turn's timeline, cut at its seams — the web's `segmentActivity`.
/// Prose, a steer, a plan and a compaction are rows the reader sees as they
/// land; everything between two of them is a run of work.
enum ActivitySegment: Equatable, Identifiable {
    case run([JournalItem])
    case row(JournalItem)

    /// A run is keyed by its FIRST item so the fold's open state survives
    /// rows appending to it.
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

/// Before this, a live turn had ONE window over everything before its last
/// narration and stacked every tool call after it as a flat row, folding only
/// when the turn finished. Now a run compacts to its tally the moment the
/// agent moves past it; only the run still being written keeps the window.
struct LiveActivityView: View {
    let items: [JournalItem]
    let tasks: [JournalTask]

    var body: some View {
        let segments = segmentActivity(items)
        let tail = segments.indices.last
        ForEach(Array(segments.enumerated()), id: \.element.id) { index, segment in
            switch segment {
            case .row(let item):
                ItemRowView(item: item)
            case .run(let run):
                ActivityGroupView(items: run, tasks: index == tail ? tasks : [], live: index == tail)
            }
        }
        // Sub-agents hang off the tail. When the tail is prose there is no
        // run to carry them, so an empty live group draws just the chips.
        if case .run? = segments.last {} else {
            ActivityGroupView(items: [], tasks: tasks, live: true)
        }
    }
}

/// A run of activity rows: a rolling window while live, a tally once
/// settled — the web's ActivityGroup. Both are the same sentence at two
/// scales, so the grammar is learned once.
struct ActivityGroupView: View {
    let items: [JournalItem]
    let tasks: [JournalTask]
    let live: Bool
    @State private var expanded = false

    /// Rows that will actually PAINT: a reasoning block the provider opened
    /// and never filled renders nothing, and a `task` item is the spawn
    /// itself — the agent it started is already on screen as its own chip.
    /// Counting either makes the tally a visible lie.
    private var rows: [JournalItem] {
        items.filter { item in
            switch item.detail {
            case .task: false
            case .reasoning: !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            default: true
            }
        }
    }

    /// The tasks the CONVERSATION shows, which is not every task in the turn.
    ///
    /// A BACKGROUNDED SHELL IS NOT A DELEGATE. This used to draw one as a chip
    /// with a terminal glyph, a "Background job" title and a sheet explaining
    /// that its output went somewhere else — dressing that made the row look
    /// deliberate without making it useful. The tool call that backgrounded the
    /// shell is ALREADY an ordinary row in this same turn, so the chip was a
    /// second, worse telling of something the transcript had said, and the live
    /// process belongs on a surface where it can be watched and stopped.
    ///
    /// A WARP RUN SURVIVES THE FILTER: its own row is `background` because it
    /// outlives its turn, but it carries warp linkage and it is the row that
    /// says a fan-out happened at all. Same rule as the web's
    /// `transcriptTasks` — the kind split happens AFTER the warp fold.
    private var delegates: [JournalTask] {
        tasks.filter { $0.task.kind != .background || $0.task.warp != nil }
    }

    /// A step that failed inside the fold must not be swallowed by the very
    /// mechanism that hid it.
    private var anyFailed: Bool {
        rows.contains { $0.status == .failed } || delegates.contains { $0.task.state == .failed }
    }

    var body: some View {
        if !rows.isEmpty || !delegates.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                if live {
                    liveWindow
                } else if !rows.isEmpty {
                    settledFold
                }
                // Sub-agents are never hidden by the fold: THAT a fan-out
                // happened is part of the conversation.
                ForEach(delegates) { task in
                    TaskRowView(task: task)
                }
            }
        }
    }

    /// Live: the last step, with "+N earlier steps" above it.
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
            ItemRowView(item: item)
        }
    }

    /// Settled: one summary row — "18 steps · Ran command ×12 · Read file ×4"
    /// — expanding to the full list behind the left hairline.
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
                Text(tally)
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
                        ItemRowView(item: item)
                    }
                }
            }
        }
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Theme.textMuted.opacity(0.6))
            .rotationEffect(.degrees(expanded ? 90 : 0))
    }

    private var failureGlyph: some View {
        Image(systemName: "exclamationmark.triangle")
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(Theme.statusRed)
    }

    /// "Ran command ×12 · Read file ×4", in first-appearance order.
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
        case .userMessage: "You steered"
        case .error: "Error"
        case .plan: "Planned"
        case .contextCompaction: "Compacted context"
        case .mcpToolCall(let call), .dynamicToolCall(let call): displayToolName(call.name)
        default: item.label
        }
    }
}

struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 0)
            Text(text)
                .font(Theme.body)
                .lineSpacing(4)
                .foregroundStyle(Theme.text)
                .padding(12)
                .background(Theme.messageSurface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusBubble))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .containerRelativeFrame(.horizontal, alignment: .trailing) { width, _ in
                    width * 0.85
                }
        }
    }
}

/// The working line: a stepped-pulse dot plus a label the light sweeps
/// across — t3code's two busy signatures, and the ONLY animated status.
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

/// t3code's `.live-activity-focus`: a 72pt-wide soft highlight translating
/// across the activity text every 2.2s, linear. Recreated as a moving
/// gradient overlay masked to the text.
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
            MarkdownText(text: item.text)
        case .userMessage:
            // Steered messages land mid-run as user_message items.
            UserBubble(text: item.text)
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
                                .font(.system(size: 12))
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
            // Rendered from turn.tasks, not from the placeholder item.
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

/// t3code's tool chip: 24pt min row, a 24pt icon gutter holding a 16pt glyph
/// at 70% opacity, one truncating muted line. No card, no border.
struct ToolChipLabel: View {
    let icon: String
    let label: String
    let status: ItemStatus?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .medium))
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
            Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.statusRed)
        case .declined:
            Image(systemName: "hand.raised").font(.system(size: 10)).foregroundStyle(Theme.statusAmber)
        default:
            EmptyView()
        }
    }
}

/// Nested content indents 28pt behind a left hairline — t3code's
/// `ms-7 border-s ps-3`, a rule instead of a box.
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

/// A sub-agent in the conversation is a CHIP, not a process: THAT a fan-out
/// happened belongs in the chat; what it did belongs on its own surface.
/// Tapping opens the agent's sheet — the phone's Agents panel.
struct TaskRowView: View {
    let task: JournalTask
    @State private var showDetail = false

    var body: some View {
        Button {
            showDetail = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "person.2")
                    .font(.system(size: 13, weight: .medium))
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
                    Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.statusRed)
                }
                Text("\(task.items.count) step\(task.items.count == 1 ? "" : "s")")
                    .font(Theme.metaSmall)
                    .foregroundStyle(Theme.textMuted.opacity(0.7))
                    .tabularNumbers()
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
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

/// The phone's Agents surface: one sub-agent's whole run — its rows and its
/// conclusion — off the conversation, where a fan-out of five can be read
/// one agent at a time.
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
                            Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.statusRed)
                            Text("Failed").font(Theme.meta).foregroundStyle(Theme.statusRed)
                        } else {
                            Image(systemName: "checkmark").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.statusEmerald)
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
