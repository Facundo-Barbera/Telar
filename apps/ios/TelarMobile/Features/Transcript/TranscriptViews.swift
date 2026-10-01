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
                UserBubble(text: turn.prompt, attachments: turn.attachments)
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


struct UserBubble: View {
    let text: String
    var attachments: [TurnAttachment]? = nil

    private var blank: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if let attachments, !attachments.isEmpty {
                SentAttachments(attachments: attachments)
            }
            if !blank || attachments?.isEmpty != false {
                HStack {
                    Spacer(minLength: 24)
                    Group {
                        if blank {
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
        .frame(maxWidth: .infinity, alignment: .trailing)
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

