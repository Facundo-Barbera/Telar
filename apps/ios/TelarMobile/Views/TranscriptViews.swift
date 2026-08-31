import SwiftUI

/// The transcript, wearing t3code's chat anatomy. The load-bearing asymmetry:
/// YOU get a bubble (right-aligned, 80% max width, 18pt radius, tinted
/// surface); THE AGENT gets bare full-width text. Tool calls are one-line
/// chips, not cards.
struct TranscriptView: View {
    let turns: [JournalTurn]

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 16) {
            ForEach(turns) { turn in
                TurnView(turn: turn)
            }
        }
        .padding(.horizontal, 12)
    }
}

struct TurnView: View {
    let turn: JournalTurn

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            UserBubble(text: turn.prompt)
            ForEach(turn.items) { item in
                ItemRowView(item: item)
            }
            ForEach(turn.tasks) { task in
                TaskRowView(task: task)
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

/// Sub-agents: a tool-chip header, expandable to their nested rows.
struct TaskRowView: View {
    let task: JournalTask
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: task.task.kind == .background ? "terminal" : "person.2")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.textMuted)
                        .opacity(0.7)
                        .frame(width: 24, height: 24)
                    Text(task.task.title ?? (task.task.kind == .background ? "Background job" : "Sub-agent"))
                        .font(Theme.body)
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                    if task.task.state.isLive {
                        SteppedPulseDot(color: Theme.statusSky)
                    } else if task.task.state == .failed {
                        Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.statusRed)
                    }
                    Text("\(task.items.count)")
                        .font(Theme.metaSmall)
                        .foregroundStyle(Theme.textMuted.opacity(0.7))
                        .tabularNumbers()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.textMuted.opacity(0.5))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 24)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                NestedDetail {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(task.items) { item in
                            ItemRowView(item: item)
                        }
                        if let result = task.task.resultText, !result.isEmpty {
                            MarkdownText(text: result)
                        }
                    }
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
