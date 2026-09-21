import SwiftUI

/// The transcript, wearing t3code's chat anatomy. The load-bearing asymmetry:
/// YOU get a bubble (right-aligned, 80% max width, 18pt radius, tinted
/// surface); THE AGENT gets bare full-width text. Tool calls are one-line
/// chips, not cards.
struct TranscriptView: View {
    let turns: [JournalTurn]
    /// WHICH TURN'S END CARRIES THE READ-RECEIPT MARKER, and nothing else does.
    ///
    /// Not "the bottom of the transcript": "is the reader at the bottom" is a
    /// different question from "is the newest ANSWER on screen". A short answer
    /// under a long tool log, a running turn below it, a composer that grew as
    /// you typed — all move the bottom without moving the answer. The view that
    /// IS the end of that turn can only be seen when that turn has been.
    var receiptMarker: EngineID?
    /// Called with the marker's own run id and whether it is on screen. The run
    /// id travels so visibility is never INHERITED across answers: a marker
    /// that was visible for turn 5 says nothing about turn 6.
    var onReceiptMarkerVisible: ((EngineID, Bool) -> Void)?

    var body: some View {
        // EAGER, not lazy. A LazyVStack only estimates the height of rows it
        // has not built, so "scroll to the bottom edge" resolves against a
        // fiction: on a long transcript it parked the viewport in a region
        // where nothing had been materialised and the screen came up BLANK.
        // A transcript is bounded (and PR 2 windows it further), so paying for
        // real heights up front is what makes the tail a real place.
        VStack(alignment: .leading, spacing: 16) {
            // CONSECUTIVE ARRIVALS ARE ONE BLOCK — #577. The 16pt above is a
            // TURN gap, and between two wakes the engine queued back to back
            // there is no turn: nobody spoke and nothing was answered, two
            // things merely arrived. A run of them is drawn at the activity
            // lane's own rhythm instead. A group of one is every other turn in
            // the conversation, rendered exactly as before.
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

/// One block of the transcript: a run of consecutive arrivals, or any other
/// single turn. Identified by its first turn's run, so loading a page of older
/// turns above cannot renumber the ones already on screen.
private struct TurnGroup: Identifiable {
    let turns: [JournalTurn]
    init(_ turns: [JournalTurn]) { self.turns = turns }
    var id: EngineID { turns.first?.runId ?? "" }
}

/// The end of one answer, as a view.
///
/// Zero-height and hidden from accessibility: it is a POSITION, not content. A
/// screen reader announcing "end of answer" would be reading out the
/// implementation. `.id(runId)` so a new answer gets a NEW marker rather than
/// inheriting the old one's reported visibility.
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

    /// The web cockpit's split (session-cockpit.tsx): a settled turn shows
    /// its ANSWER and folds everything that produced it, so history reads as
    /// conclusions. The split point is the LAST assistant message —
    /// narration in the middle folds with the work it narrates.
    ///
    /// It applies to the ANSWERING response only: that is the one whose final
    /// message is the answer to the turn. An earlier response's prose is part
    /// of what it did about a steer, not a conclusion.
    private func split(_ items: [JournalItem]) -> (activity: [JournalItem], closing: [JournalItem]) {
        let lastProse = items.lastIndex { item in
            if case .assistantMessage = item.detail { return true }
            return false
        }
        guard let lastProse else { return (items, []) }
        return (Array(items[..<lastProse]), Array(items[lastProse...]))
    }

    var body: some View {
        // THE TURN'S RESPONSES. A message sent into a running turn is a
        // boundary in the conversation, so the work after it belongs to it and
        // is drawn UNDER it. One response is every turn nobody steered, and it
        // renders exactly as it did before.
        // The opening arrival is drawn ONCE, by the header below (#590) — the
        // one that is handed `turn.prompt`, so a peer's row carries the head of
        // what was actually sent rather than the head of the envelope about it.
        let responses = splitAtMessageBoundaries(withoutOpeningNotification(turn))
        let answering = responses[responses.count - 1]
        let earlier = responses.dropLast()
        let orphans = spawnlessTasks(turn.items, tasks: turn.tasks)
        let (activity, closing) = split(answering.items)
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
            // WHO SENT THIS DECIDES WHAT IT LOOKS LIKE. A bubble on the right
            // means "you said this"; a peer's report and a wake-up are neither,
            // and drawing them as bubbles put words in the reader's mouth —
            // twenty lines of another agent's status, right-aligned, as though
            // they had typed it.
            // A NOTIFICATION TURN IS A NOTIFICATION ROW (#550), and first —
            // it is the honest description of every session-origin turn the
            // engine now writes. The arms under it are what a turn stored
            // before this existed still falls back to.
            if turn.notification != nil {
                NotificationTurnRow(turn: turn)
            } else if turn.isWake || turn.isProviderStarted {
                WakeRow(turn: turn)
            } else if turn.isFromAgent {
                AgentMessageRow(turn: turn)
            } else {
                UserBubble(text: turn.prompt)
            }
            // A BOUNDARY INTRODUCES THE WORK UNDER IT — the message first,
            // then what the agent did about it. Every response but the last is
            // finished work, cut at its seams with no rolling window.
            ForEach(Array(earlier.enumerated()), id: \.element.boundary?.id) { _, response in
                if let boundary = response.boundary {
                    ItemRowView(item: boundary)
                }
                LiveActivityView(items: response.items, tasks: turn.tasks, liveTail: false)
            }
            if let boundary = answering.boundary {
                ItemRowView(item: boundary)
            }
            // LIVE, THE WHOLE TIMELINE IS CUT AT ITS SEAMS — each run of work
            // folds to its tally as the agent moves past it. The prose split
            // is for a FINISHED turn: only then is the last message the answer.
            // Live and settled cut in the same place, so a reload cannot move
            // a message.
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
        // The web's SEAM set, minus `provider_wait`: this build's `ItemDetail`
        // has no such case, so there is nothing here to seam on. Add it here
        // when the item arrives — a wait explains something the reader can
        // otherwise only experience as the session hanging.
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

/// A TURN, CUT INTO RESPONSES AT ITS MESSAGE BOUNDARIES. A message sent into a
/// running turn is a boundary in the CONVERSATION, not an event inside the
/// work: what the agent does next is a response TO it.
///
/// The phone folded every item into one group, so a steer vanished into
/// "N steps" and the work it caused was drawn above it. The first response has
/// no boundary — its cause is the turn's prompt, drawn above. (The web's
/// `splitAtMessageBoundaries`, 1:1.)
struct TurnResponse: Equatable {
    var boundary: JournalItem?
    var items: [JournalItem]
}

/// ONE ARRIVAL DRAWS ONE NOTIFICATION ROW — issue #590, on the phone.
///
/// An arrival that opens a turn is stored TWICE on purpose: on the turn, and on
/// the turn's first item (`notification.ts`). The Mac learned to draw only one
/// of them; this phone drew both — `NotificationTurnRow` above, and the
/// `notification_<runId>` item again as the first response's boundary. For a
/// peer's message the two at least differed; for a WAKE, which has no message on
/// either side, they were the identical line, twice.
///
/// KEYED ON THE ITEM'S ID, which the engine mints from the run — never on
/// matching summaries. A text heuristic eventually eats a real second arrival
/// from the same session, which is the failure that costs someone an errand.
/// A notification that landed MID-TURN has an id of its own and no header
/// announcing it, so it is untouched: drawing it is what the item row is for.
/// (The web's `withoutOpeningNotification`, 1:1.)
func withoutOpeningNotification(_ turn: JournalTurn) -> [JournalItem] {
    guard turn.notification != nil, turn.origin == "session" || turn.origin == "provider" else { return turn.items }
    let drawn = "notification_\(turn.runId)"
    return turn.items.filter { $0.id != drawn }
}

/// A TURN THAT IS NOTHING BUT AN ARRIVAL — issue #577.
///
/// THE QUESTION IS WHAT THIS SCREEN WOULD DRAW, not what the turn is called. A
/// usage footnote, a failure line, a `Stopped` marker and — on the phone, unlike
/// the Mac — the `Queued`/`Working` indicator every pending turn carries are all
/// things a reader sees under the row, and a strip that swallowed one would be
/// hiding it. Only a turn with literally nothing beneath its row is bare.
func bareNotificationTurn(_ turn: JournalTurn) -> Bool {
    guard turn.notification != nil else { return false }
    guard withoutOpeningNotification(turn).isEmpty else { return false }
    guard turn.resultText.isEmpty, turn.failure == nil, turn.usage == nil else { return false }
    guard !turn.state.isActive else { return false }
    return turn.state != .failed && turn.state != .stopped && turn.state != .discarded
}

/// CONSECUTIVE ARRIVALS ARE ONE STRIP — issue #577. (The Mac's
/// `groupNotificationTurns`, 1:1.)
///
/// A run of notification turns with nothing between them is ONE thing that
/// happened to this session while it worked, so it is drawn as one tight block
/// of one-line rows rather than as N conversations with a turn gap each. The run
/// ENDS at the first turn that answered: that turn's row still joins the strip —
/// it is an arrival like the others — and its reply hangs under it at the
/// ordinary paragraph gap, which is what the reader came for.
///
/// EVERY TURN COMES BACK, in order, in exactly one group. A turn that is not an
/// arrival is a group of one and renders as it always did; so is a lone arrival,
/// which is the "a group of one is one line" case.
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
        // `notification` seams for `user_message`'s reason: something ARRIVED,
        // and what follows is the turn's answer to it (#550).
        if case .userMessage = item.detail {
            responses.append(TurnResponse(boundary: item, items: []))
        } else if case .notification = item.detail {
            responses.append(TurnResponse(boundary: item, items: []))
        } else {
            responses[responses.count - 1].items.append(item)
        }
    }
    // A turn whose only message is its own prompt is one response, and renders
    // exactly as it always did.
    return responses.count > 1 && responses[0].items.isEmpty ? Array(responses.dropFirst()) : responses
}

/// THE ORDER THE TURN IS EMITTED IN — a boundary, then the work it introduced,
/// for every response. `TurnView` renders exactly this sequence, so a test over
/// it is a test of the assembly and not merely of the splitter's shape: a
/// splitter can group correctly while the view still draws each response's
/// work above the message that caused it.
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

/// The tasks the CONVERSATION shows, which is not every task in the turn.
///
/// A BACKGROUNDED SHELL IS NOT A DELEGATE. The tool call that backgrounded it
/// is ALREADY an ordinary row in this same turn, so a chip would be a second,
/// worse telling of something the transcript had said. THERE IS NO EXCEPTION:
/// a Warp run's own row was `background` and used to survive this, because it
/// was the row that said a fan-out had happened at all. #877 retired Warp, so
/// `kind` is the whole rule — the same rule as the web's `transcriptTasks`.
func transcriptTasks(_ tasks: [JournalTask]) -> [JournalTask] {
    tasks.filter { $0.task.kind != .background }
}

/// Rows that will actually PAINT.
///
/// A `task` ITEM IS THE SPAWN ITSELF — the tool call that started a sub-agent —
/// and it IS a row, in the run, at the place it happened. The phone used to
/// drop it and hang every chip off the tail of the turn instead, so a fan-out
/// that happened in the first minute was drawn under twenty minutes of later
/// work. A spawn whose task the conversation does not show (a backgrounded
/// shell) is dropped; one whose task is missing entirely is kept, because the
/// transcript has nothing else that says it happened.
///
/// A reasoning block the provider opened and never filled paints nothing, and
/// counting it makes the tally a visible lie.
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

/// A SPAWN ROW NEVER FOLDS WHILE ITS AGENT IS OUT — a still-running fleet
/// hidden behind "12 steps" is invisible exactly when the reader most wants to
/// see it. A settled run is cut around its live spawns; each cut is tallied on
/// its own and the spawn rows stand between them, in place. (The web's
/// `cutAroundLiveAgents`.)
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

/// Tasks with NO spawn row anywhere in the turn. Nothing in the timeline says
/// they happened, so they cannot be drawn in place — the fold parks them at
/// the end rather than losing a chip.
func spawnlessTasks(_ items: [JournalItem], tasks: [JournalTask]) -> [JournalTask] {
    let spawned = Set(items.compactMap { item -> EngineID? in
        if case .task(let taskId) = item.detail { return taskId }
        return nil
    })
    return transcriptTasks(tasks).filter { !spawned.contains($0.id) }
}

/// Before this, a live turn had ONE window over everything before its last
/// narration and stacked every tool call after it as a flat row, folding only
/// when the turn finished. Now a run compacts to its tally the moment the
/// agent moves past it; only the run still being written keeps the window.
struct LiveActivityView: View {
    let items: [JournalItem]
    let tasks: [JournalTask]
    /// An EARLIER response is finished work even while the turn runs: its last
    /// run is a tally, not a rolling window. Only the response the agent is
    /// answering keeps the window.
    var liveTail = true
    /// Chips with no spawn row to stand on — parked at the end.
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

/// A run of activity rows: a rolling window while live, a tally once
/// settled — the web's ActivityGroup. Both are the same sentence at two
/// scales, so the grammar is learned once.
struct ActivityGroupView: View {
    let items: [JournalItem]
    /// EVERY task in the turn — a `task` row inside `items` is looked up here
    /// so its chip draws where the spawn happened.
    let tasks: [JournalTask]
    let live: Bool

    var body: some View {
        let rows = renderable(items, tasks: tasks)
        if !rows.isEmpty {
            let cuts = cutAroundLiveAgents(rows, tasks: tasks)
            // Only the LAST run keeps the rolling window; the runs a live
            // spawn was cut out of are behind it and are already tallies.
            let lastRun = cuts.lastIndex { if case .run = $0 { return true } else { return false } }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(cuts.enumerated()), id: \.element.id) { index, cut in
                    switch cut {
                    case .agent(let item):
                        // Never hidden by the fold: THAT a fan-out is out is
                        // part of the conversation.
                        TaskChipRow(item: item, tasks: tasks)
                    case .run(let run):
                        ActivityRunView(rows: run, tasks: tasks, live: live && index == lastRun)
                    }
                }
            }
        }
    }
}

/// A spawn row: the task it named, or — when the turn carries no such task —
/// the row itself saying a sub-agent was started.
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

/// HOW A RUN OF WORK FOLDS, at both of its scales, over ANY row.
///
/// A rolling window while live — the newest step, with "+N earlier steps" above
/// it — and one summary line once settled. Both are the same sentence at two
/// scales, so the grammar is learned once. Its own fold state, so two runs in
/// the same response open independently.
///
/// GENERIC OVER THE ROW, because the Agent's conversation folds by these same
/// two rules over `AgentRow` and not `JournalItem` at all (#569). Its tool calls
/// were drawn one flat line each — twelve calls, twelve lines — for exactly as
/// long as this chrome could only be handed a session's items. What a row LOOKS
/// like never reaches here: `content` draws it however that screen draws it, and
/// the only two questions asked about a row are whether it failed and what the
/// tally calls it.
///
/// THE FAILURE MARK IS A GLYPH, NOT A COUNT — the phone's own choice, and it
/// reads every row rather than only the hidden ones: a run with a failure in it
/// says so on the line that hides it, and a number on a phone-width row would
/// cost the tally the space it needs.
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

    /// A step that failed inside the fold must not be swallowed by the very
    /// mechanism that hid it.
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
            content(item)
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

/// One run of a SESSION's activity rows. All that is left here is what a
/// session's items mean — which failed, what the tally calls each one, and which
/// view draws one; the fold itself is `StepFoldView`, shared with the Agent's
/// conversation.
struct ActivityRunView: View {
    /// Already filtered by `renderable` — this view counts what it is given.
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

    /// A settled spawn folds into the tally like any other step, but when it
    /// is shown it is the agent it started, not an empty placeholder.
    @ViewBuilder private func row(_ item: JournalItem) -> some View {
        if case .task = item.detail {
            TaskChipRow(item: item, tasks: tasks)
        } else {
            ItemRowView(item: item)
        }
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
        // "You steered" is a claim about who typed it, so it is only true of a
        // message the person actually sent.
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

/// The notice's FIRST LINE. The rest of it — how to fetch the body — is for
/// the model that was handed it, not for a row one line tall. The web's
/// `noticeLine`, 1:1.
func noticeFirstLine(_ notice: String) -> String {
    notice.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
        .first.map(String.init) ?? notice
}

/// A PEER'S MESSAGE, COLLAPSED — whatever it meant by sending and however long
/// it is. `[intent] · notice first line ›`, tap for the body in a bounded
/// scroll. The desktop's `AgentMessageBubble`, ported.
///
/// A TASK USED TO RENDER IN FULL here, on the reasoning that the instruction is
/// why the session is doing anything. It also let a peer decide how much of
/// someone else's prose sat between two of the reader's own messages: on this
/// screen that was a worker's 3 KB report, unlabelled, with nothing to collapse
/// it. The notice already carries the instruction's opening and the scope, and
/// both stay on the header line.
///
/// It sits on the LEFT, in the assistant's lane. The attribution is the
/// engine's, stamped from a claim token, so nothing a model writes can change
/// whose name is on it.
struct AgentNoticeRow: View {
    /// `agentSenderLabel` of whoever sent it — the engine's attribution.
    let senderLabel: String
    /// What the peer meant by sending: `task`, `report`, `result`, `blocker`.
    /// Absent on a message steered mid-turn, which the engine stamps on the
    /// turn rather than the item; the row keeps its old wording for those.
    var intent: String?
    /// The engine's announcement. Preferred verbatim (first line) when present.
    var notice: String?
    /// What was actually sent — the body behind the disclosure.
    let message: String
    var scope: String?
    @State private var open = false

    /// The engine's own sentence when it wrote one; otherwise the first line
    /// of what was sent, which is what a sender puts there anyway.
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
                    // BOUNDED, WITH ITS OWN SCROLL. An unbounded peer report is
                    // how this looked before: a wall of someone else's status
                    // between two of your own messages.
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

/// A TURN ANOTHER SESSION SENT — the collapsed row above, filled from the turn.
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

/// A WAKE IS NOT A MESSAGE. Nobody said it: the engine woke the model because
/// something it was waiting on happened. It is one muted line in the
/// assistant's lane, shaped like the compaction row, and it never expands —
/// the run it is about is the thing worth opening, and that is elsewhere.
struct WakeRow: View {
    /// WHAT HAPPENED, from the structured reason and nothing else (#572). The
    /// engine's own notice used to BE this line — so a peer's result and the
    /// completion behind it both read "Session finished a turn.", one sentence
    /// printed twice for two different facts. The notice is the `head` now.
    let line: String
    /// The head of the words themselves, under the verb. Absent when the wake
    /// announced something in another session's run and there is none here.
    var head: String?

    init(line: String, head: String? = nil) {
        self.line = line
        self.head = head
    }

    /// A wake that arrived as its OWN TURN, the recipient being idle.
    init(turn: JournalTurn) {
        // A provider-started turn has NO prompt at all — that is its whole
        // shape — so its own kind is the only thing there is to say.
        line = turn.isProviderStarted ? describeProviderWake(turn.providerReason) : describeWake(turn.wakeReason)
        head = notificationHead(turn.agentNotice) ?? notificationHead(turn.prompt)
    }

    /// The MID-TURN twin: the engine steered the same wake into a running turn.
    /// Same line, so the reader sees one kind of thing however it landed.
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

/// WHAT A NOTIFICATION IS CALLED, in one line — issue #550.
///
/// The Mac's `notificationLabel`, 1:1, and like it the ONE place a happening
/// becomes a word on this phone (#572). `describeWake` is an adapter onto it,
/// so a wake reaching a row in the other shape cannot be named differently —
/// and a peer's `result` can no longer be classified as the completion that
/// follows it a few seconds later.
func describeNotification(_ detail: NotificationDetail) -> String {
    notificationVerb(kind: detail.kind, intent: detail.intent, wakeKind: detail.wakeKind)
}

/// The head of what was actually sent, for a peer's row — the Mac's
/// `notificationHead`, to the character. Enough to tell a result from the
/// result before it; not the message, which is behind the disclosure.
func describeNotificationHead(_ detail: NotificationDetail, message: String? = nil) -> String? {
    guard detail.kind == "peer_message" else { return nil }
    return notificationHead(message ?? detail.summary)
}

/// A NOTIFICATION — a peer's message, a wake, a parked request. #550.
///
/// NOT A BUBBLE OF ANYONE'S, which is the whole point: all three reached this
/// session without a person typing, and this phone drew two of them on the
/// right of the screen as though the reader had. One line collapsed — a bell,
/// what happened, whose session — with the notice behind a tap, and the peer's
/// actual message behind a second one when there IS one on this side.
struct NotificationRow: View {
    let detail: NotificationDetail
    /// The body as sent, for a peer's message. A wake announces something in
    /// ANOTHER session's run and has none here.
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
                    // WHICH RESULT, not just that one arrived — #572. Two
                    // notices from one session on one screen have to be told
                    // apart without expanding both.
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
                // THE ACTIVITY LANE'S OWN ROW HEIGHT — #577, and the Mac's
                // shared `ROW`. An arrival is a step-lane line, not a message
                // block: the same 24pt minimum every fold row has, which is
                // also the tap target this row was missing.
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
                        // THE ACTION THE ROW IS FOR. The notice announces a
                        // message rather than quoting it — that is what keeps a
                        // recipient's context cheap — so the row has to offer
                        // the thing it announced.
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

/// A TURN THAT IS A NOTIFICATION — the row above, filled from the turn.
struct NotificationTurnRow: View {
    let turn: JournalTurn

    var body: some View {
        if let detail = turn.notification {
            // The body is only this turn's when a PEER sent it; a wake's turn
            // carries a machine label, and offering that as "the message" would
            // be a dead end.
            NotificationRow(detail: detail, message: turn.sender != nil ? turn.prompt : nil)
        }
    }
}

struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            // Use the proposed column width. A container-relative width can
            // resolve to the whole split view and force an iPad detail underneath its sidebar.
            Spacer(minLength: 24)
            Text(text)
                .font(Theme.body)
                .lineSpacing(4)
                .foregroundStyle(Theme.text)
                .padding(12)
                .background(Theme.messageSurface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusBubble))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .fixedSize(horizontal: false, vertical: true)
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
            // An OPEN message is still streaming, so it is paced — the tail
            // polls once a second and would otherwise paint each second's
            // deltas in one block. Mirrors the web's `running(item)`.
            StreamingMarkdown(text: item.text, streaming: item.status == .inProgress)
        case .notification(let detail):
            // #550: its own arm, ABOVE `user_message`, because the point of the
            // type is that narrowing on it is what gives you the payload —
            // there is no `sender` or `wakeReason` field left to forget.
            NotificationRow(detail: detail)
        case .userMessage(let message):
            // Steered messages land mid-run as user_message items — and WHO
            // SENT ONE decides what it looks like, exactly as it does for a
            // turn. This drew every one of them as the person's bubble, so a
            // peer's 3 KB report sat on the right of the screen as though the
            // reader had typed it. The web's `SteeredMessageRow` order, 1:1:
            // a wake first (keyed on the structured stamp, never on the
            // `[wake: …]` text), then a peer, then the person.
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
            .contextMenu { rowMenu }
        }
    }

    @Environment(\.panel) private var panel

    /// THE ROW'S MENU IS ABOUT WHAT THE ROW IS ABOUT — the web's rule, row for
    /// row: a command row offers its command, a file row offers its path, its
    /// reference, and the one thing the row cannot do by itself, which is open
    /// it. Each item appears only when the row carries that datum.
    ///
    /// NOTHING HERE IS A VERB. A transcript is a record, and a menu on a record
    /// that could re-run a command or undo an edit would be offering to change
    /// what happened.
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
            // The path is workspace-relative, the same space the tree lists.
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

    /// A deleted file has a path worth copying but nothing left to open.
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

/// t3code's tool chip: 24pt min row, a 24pt icon gutter holding a 16pt glyph
/// at 70% opacity, one truncating muted line. No card, no border.
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
