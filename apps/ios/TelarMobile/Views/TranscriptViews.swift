import SwiftUI

/// The transcript: for each turn, the prompt bubble then rows by item kind.
struct TranscriptView: View {
    let turns: [JournalTurn]

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 12) {
            ForEach(turns) { turn in
                TurnView(turn: turn)
            }
        }
        .padding(.horizontal)
    }
}

struct TurnView: View {
    let turn: JournalTurn

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Spacer(minLength: 40)
                Text(turn.prompt)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color.accentColor.opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 16))
            }
            ForEach(turn.items) { item in
                ItemRowView(item: item)
            }
            ForEach(turn.tasks) { task in
                TaskRowView(task: task)
            }
            switch turn.state {
            case .failed:
                Label(turn.failure ?? "Turn failed", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            case .stopped:
                Label("Stopped", systemImage: "stop.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            case .running, .claimed, .queued, .steering:
                WorkingIndicator(turn: turn)
            default:
                EmptyView()
            }
        }
    }
}

struct WorkingIndicator: View {
    let turn: JournalTurn

    var body: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.small)
            Text(turn.isCompacting ? "Compacting context…" : turn.state == .queued ? "Queued" : "Working…")
                .font(.caption)
                .foregroundStyle(.secondary)
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
            HStack {
                Spacer(minLength: 40)
                Text(item.text)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color.accentColor.opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 16))
            }
        case .reasoning:
            DisclosureGroup(isExpanded: $reasoningExpanded) {
                Text(item.text)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            } label: {
                Label("Thought", systemImage: "brain")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .plan(let plan):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(plan.steps.enumerated()), id: \.offset) { _, step in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: step.status == .completed ? "checkmark.circle.fill"
                              : step.status == .inProgress ? "arrow.triangle.2.circlepath" : "circle")
                            .font(.caption)
                            .foregroundStyle(step.status == .completed ? .green : .secondary)
                        Text(step.step)
                            .font(.caption)
                            .strikethrough(step.status == .completed)
                    }
                }
            }
            .padding(10)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        case .error(let error):
            Label(error.message, systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(.red)
        case .contextCompaction(_, let pre, let post):
            HStack {
                VStack { Divider() }
                Text(compactionLabel(pre: pre, post: post))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize()
                VStack { Divider() }
            }
        case .task:
            // Rendered from turn.tasks, not from the placeholder item.
            EmptyView()
        case .unknown(let label):
            Text(label ?? "unknown item")
                .font(.caption)
                .foregroundStyle(.tertiary)
        default:
            // Tool rows: one compact line, engine-produced label, tap for detail.
            Button {
                showDetail = true
            } label: {
                HStack(spacing: 6) {
                    statusGlyph
                    Text(item.label)
                        .font(.system(.caption, design: .monospaced))
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            .sheet(isPresented: $showDetail) {
                ToolDetailSheet(item: item)
            }
        }
    }

    private func compactionLabel(pre: Int?, post: Int?) -> String {
        if let pre, let post {
            return "Context compacted \(pre / 1000)k → \(post / 1000)k"
        }
        return "Context compacted"
    }

    private var statusGlyph: some View {
        Group {
            switch item.status {
            case .inProgress: ProgressView().controlSize(.mini)
            case .completed: Image(systemName: "checkmark").foregroundStyle(.green)
            case .failed: Image(systemName: "xmark").foregroundStyle(.red)
            case .declined: Image(systemName: "hand.raised").foregroundStyle(.orange)
            case .unknown: Image(systemName: "questionmark").foregroundStyle(.secondary)
            }
        }
        .font(.caption2)
    }
}

/// Sub-agents collapsed to one row each, expandable to their items.
struct TaskRowView: View {
    let task: JournalTask
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(task.items) { item in
                    ItemRowView(item: item)
                }
                if let result = task.task.resultText, !result.isEmpty {
                    MarkdownText(text: result)
                        .padding(.top, 2)
                }
            }
            .padding(.leading, 4)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: task.task.kind == .background ? "terminal" : "person.2")
                    .font(.caption)
                Text(task.task.title ?? (task.task.kind == .background ? "Background job" : "Sub-agent"))
                    .font(.caption)
                    .lineLimit(1)
                if task.task.state.isLive {
                    ProgressView().controlSize(.mini)
                } else if task.task.state == .failed {
                    Image(systemName: "xmark").font(.caption2).foregroundStyle(.red)
                }
                Text("\(task.items.count) steps")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .foregroundStyle(.secondary)
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
                            Text(cwd).font(.caption2).foregroundStyle(.tertiary)
                        }
                        CodeBlockView(code: command.command)
                        if let exit = command.exitCode {
                            Text("exit \(exit)")
                                .font(.caption)
                                .foregroundStyle(exit == 0 ? Color.secondary : Color.red)
                        }
                    case .fileChange(let change):
                        Text("\(change.kind) · \(change.path)").font(.caption)
                        if let diff = change.unifiedDiff {
                            CodeBlockView(code: diff)
                        }
                    case .fileRead(let read):
                        Text(read.path).font(.system(.caption, design: .monospaced))
                    case .mcpToolCall(let call), .dynamicToolCall(let call), .browserAction(let call, _):
                        if let input = call.input {
                            Text("Input").font(.caption).foregroundStyle(.secondary)
                            CodeBlockView(code: input.prettyPrinted)
                        }
                    case .webSearch(let query, let count):
                        Text(query)
                        if let count { Text("\(count) results").font(.caption).foregroundStyle(.secondary) }
                    default:
                        EmptyView()
                    }
                    let streamed = item.streamedText
                    let output = streamed.isEmpty ? item.toolOutput : streamed
                    if let output, !output.isEmpty {
                        Text("Output").font(.caption).foregroundStyle(.secondary)
                        CodeBlockView(code: output)
                    }
                }
                .padding()
            }
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
