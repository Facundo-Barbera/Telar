import SwiftUI

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
                UserBubble(text: item.text, attachments: message.attachments)
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
