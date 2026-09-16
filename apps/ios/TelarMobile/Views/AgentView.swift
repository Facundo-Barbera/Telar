import SwiftUI

/// ONE MAC'S BUILT-IN AGENT, on the phone (#531).
///
/// ── IT IS NOT `SessionView`, AND CANNOT BE ─────────────────────────────────
/// The Main band this replaces opened an ordinary `SessionView`, because Main
/// WAS an ordinary session: it had an id, a journal, turns, items and a store,
/// and being Main added a briefing the phone never saw.
///
/// The Agent has none of those. There is no session id, no journal to sync, no
/// turn record and no `SessionStore` to build — there is a flat log of rows and
/// one thread. So this is its own screen, and it is deliberately the small one:
/// a transcript, a composer, a Stop, and the approval it may be parked on.
///
/// ── IT POLLS, IT DOES NOT STREAM ───────────────────────────────────────────
/// The desktop follows `/api/agent/stream` over server-sent events. This phone
/// does not, and that is a decision rather than a gap: a long-lived connection
/// is the thing the mobile client is built to avoid — it is held open across
/// backgrounding, it costs a socket per paired Mac, and the phone already has a
/// poll cadence that every other surface here rides.
///
/// SO IT ASKS AGAIN FROM ITS CURSOR, which is the same contract the stream
/// serves: `after` is exclusive, the answer is forward-only, and rows merge by
/// id. Nothing is missed and nothing is duplicated. What is lost is token-level
/// streaming, which on a phone showing a conversation somebody else's machine
/// is having is not what the screen is for.
///
/// ── WHAT IS ABSENT IS ABSENT BY CONSTRUCTION ───────────────────────────────
/// No project header, no checkout, no diff, no run, no model picker: none of
/// them has anything to hang off, because there is no session and no workspace.
struct AgentView: View {
    let hostId: HostID
    let api: any EngineAPI

    @State private var rows: [AgentRow] = []
    @State private var state: AgentState?
    @State private var credential: AgentCredential?
    @State private var cursor = 0
    @State private var draft = ""
    @State private var loading = true
    @State private var sending = false
    @State private var failure: String?

    /// HOW MANY PAGES A FIRST READ WILL WALK.
    ///
    /// The Mac pages FORWARD only — `after` is exclusive and `0` is the
    /// beginning — so opening a long conversation means walking it. Each page is
    /// bounded by a count and a byte budget over there; this bounds the walk, so
    /// a thread that has run for a month costs a screenful of history rather
    /// than the whole of it. A ceiling, not a target.
    private static let maxPages = 20

    /// HOW OFTEN IT ASKS AGAIN — the phone's ordinary cadence, and deliberately
    /// not faster. This screen is watching a conversation another machine is
    /// having; three seconds is well inside the time it takes to read a reply.
    private static let pollSeconds: UInt64 = 3

    var body: some View {
        VStack(spacing: 0) {
            if loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if state?.enabled != true {
                // OFF IS A SENTENCE, NOT AN EMPTY LIST. The destination is
                // reachable whenever the sidebar drew a row for it, and the row
                // is drawn from the Mac's own flag — so this is what a reader
                // sees when the Agent is switched off over there between the
                // poll that drew the row and the tap that opened it.
                ContentUnavailableView(
                    "The Agent is off",
                    systemImage: "sparkles",
                    description: Text("Its switch, its model and its key are set in Telar’s Settings on that Mac.")
                )
            } else {
                transcript
                composer
            }
        }
        .navigationTitle("Agent")
        .navigationBarTitleDisplayMode(.inline)
        .task { await follow() }
    }

    // ── THE TRANSCRIPT ───────────────────────────────────────────────────────

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if let credential, credential.source == nil {
                        // NO KEY IS SAID HERE rather than left for the first
                        // turn to fail: the conversation exists, it simply
                        // cannot call a model yet, and somebody who has just
                        // switched this on has no reason to know a key is a
                        // separate step.
                        notice("The Agent has no OpenCode Go key yet, so it cannot answer. Add one in Telar’s Settings on that Mac.")
                    }
                    if let failure {
                        notice(failure)
                    }
                    if rows.isEmpty {
                        Text("Nothing yet. Ask it what is happening across your sessions, or hand it something to delegate.")
                            .font(.subheadline)
                            .foregroundStyle(Theme.textMuted)
                            .padding(.vertical, 8)
                    }
                    ForEach(drawn) { row in
                        AgentRowView(row: row)
                    }
                    // THE OPEN APPROVAL IS LIVE STATE, NOT HISTORY — one card at
                    // the bottom, off the Agent's own state. A card drawn from
                    // the row log would resurrect decisions already made.
                    if let request = state?.request {
                        AgentApprovalCard(request: request, sending: sending) { accept in
                            Task { await resolve(request.id, accept: accept) }
                        }
                    }
                    Color.clear.frame(height: 1).id(bottomAnchor)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .onChange(of: rows.count) { _, _ in
                withAnimation { proxy.scrollTo(bottomAnchor, anchor: .bottom) }
            }
        }
    }

    private let bottomAnchor = "agent-bottom"

    /// WHAT IS WORTH DRAWING. `turn_started` says nothing the user message above
    /// it does not, and the two request rows are the history of a decision whose
    /// card is live state — so all three are dropped rather than rendered as
    /// empty lines in the middle of a conversation.
    private var drawn: [AgentRow] {
        rows.filter { row in
            switch row.kind {
            case .turnStarted, .requestOpened, .requestResolved: return false
            case .assistantMessage, .userMessage: return !(row.text ?? "").isEmpty
            case .turnDone:
                // A completed turn with nothing to say only ran tools; a failed
                // or stopped one is worth a line either way.
                return row.status != "completed" || !(row.text ?? "").isEmpty
            case .toolCall: return true
            }
        }
    }

    private func notice(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Theme.textMuted)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // ── THE COMPOSER ─────────────────────────────────────────────────────────

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Message the Agent", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .disabled(sending)
            // STOP REPLACES SEND WHILE A TURN RUNS, rather than sitting beside
            // it: there is one thread and one turn at a time, so the two are
            // never both the thing to press.
            if state?.running == true {
                Button { Task { await cancel() } } label: {
                    Image(systemName: "stop.circle.fill").font(.title2)
                }
                .accessibilityLabel("Stop the Agent")
            } else {
                Button { Task { await send() } } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
                .accessibilityLabel("Send")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    // ── READS AND WRITES ─────────────────────────────────────────────────────

    /// Page the transcript once, then keep asking from the cursor.
    private func follow() async {
        await refreshState()
        await page()
        loading = false
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(Self.pollSeconds))
            if Task.isCancelled { return }
            await refreshState()
            await page()
        }
    }

    private func refreshState() async {
        do {
            let answer = try await api.agent()
            state = answer.agent
            credential = answer.credential
            failure = nil
        } catch {
            // A MAC THAT DID NOT ANSWER KEEPS WHAT IS ON SCREEN. The rows are
            // still worth reading, and the next poll is three seconds away.
            failure = "That Mac did not answer."
        }
    }

    private func page() async {
        var after = cursor
        for _ in 0..<Self.maxPages {
            guard let page = try? await api.agentThread(after: after) else { return }
            rows = mergeAgentRows(rows, page.rows)
            after = page.cursor
            cursor = after
            if !page.more { return }
        }
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        draft = ""
        defer { sending = false }
        do {
            let accepted = try await api.sendAgentTurn(text)
            if let agent = accepted.agent { state = agent }
            await page()
        } catch {
            failure = "That Mac refused the message."
            // THE TEXT COMES BACK rather than being lost to a failed send.
            draft = text
        }
    }

    private func cancel() async {
        guard let runId = state?.runId else { return }
        try? await api.cancelAgentTurn(runId)
        await refreshState()
    }

    private func resolve(_ requestId: EngineID, accept: Bool) async {
        sending = true
        defer { sending = false }
        try? await api.resolveAgentRequest(requestId, accept: accept)
        await refreshState()
        await page()
    }
}

/// ONE ROW OF THE AGENT'S CONVERSATION.
struct AgentRowView: View {
    let row: AgentRow
    @State private var open = false

    var body: some View {
        switch row.kind {
        case .userMessage:
            VStack(alignment: .trailing, spacing: 4) {
                if let wake = row.wakeLabel {
                    Text(wake).font(Theme.monoSmall).foregroundStyle(Theme.textMuted)
                }
                Text(row.text ?? "")
                    .font(.subheadline)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .frame(maxWidth: .infinity, alignment: .trailing)

        case .assistantMessage:
            MarkdownText(text: row.text ?? "").frame(maxWidth: .infinity, alignment: .leading)

        case .turnDone:
            if row.status == "completed" {
                MarkdownText(text: row.text ?? "").frame(maxWidth: .infinity, alignment: .leading)
            } else {
                // A PERSON WHO PRESSED STOP KNOWS WHY THE TURN ENDED. One that
                // fell over owes them the sentence.
                Label(
                    row.status == "stopped" ? "Stopped." : (row.text ?? "The turn failed."),
                    systemImage: row.status == "stopped" ? "stop.circle" : "exclamationmark.triangle"
                )
                .font(.footnote)
                .foregroundStyle(row.status == "stopped" ? Theme.textMuted : Theme.statusRed)
            }

        case .toolCall:
            // ONE LINE UNTIL IT IS ASKED TO BE MORE. The Agent's tools are the
            // sessions and notes walls — reads that answer in paragraphs — and a
            // conversation that printed every answer in full would be
            // unreadable on a phone.
            VStack(alignment: .leading, spacing: 6) {
                Button { open.toggle() } label: {
                    HStack(spacing: 6) {
                        Image(systemName: open ? "chevron.down" : "chevron.right")
                        Image(systemName: "wrench.and.screwdriver")
                        Text(displayToolName(row.name ?? "tool")).font(Theme.monoSmall)
                        if row.status == "failed" {
                            Text("failed").font(Theme.monoSmall).foregroundStyle(Theme.statusRed)
                        } else if row.status == "declined" {
                            Text("denied").font(Theme.monoSmall).foregroundStyle(Theme.textMuted)
                        }
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Theme.textMuted)
                }
                .buttonStyle(.plain)
                if open, let output = row.output, !output.isEmpty {
                    Text(output)
                        .font(Theme.monoSmall)
                        .foregroundStyle(Theme.textMuted)
                        .padding(.leading, 18)
                }
            }

        case .turnStarted, .requestOpened, .requestResolved:
            // Filtered out upstream; drawn as nothing if one ever reaches here.
            EmptyView()
        }
    }
}

/// THE APPROVAL THE AGENT IS PARKED ON.
///
/// NOT `RequestCardView`, for two reasons and both are structural. That one
/// takes an `EngineRequest` and a `SessionStore` — the Agent has neither. And it
/// offers a session's three choices, where the Agent's route takes accept or
/// decline: its gate is argument-aware and decided per call, so there is
/// nothing an "always" could attach to. A button no route could honour is the
/// worst thing to put on the screen where somebody is deciding exactly how much
/// rope to hand over.
struct AgentApprovalCard: View {
    let request: AgentRequest
    let sending: Bool
    let decide: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(displayToolName(request.tool), systemImage: "shield")
                .font(.subheadline.weight(.medium))
            if !request.reason.isEmpty {
                Text(request.reason).font(.footnote).foregroundStyle(Theme.textMuted)
            }
            HStack(spacing: 16) {
                Spacer(minLength: 0)
                Button("Deny") { decide(false) }
                    .foregroundStyle(Theme.statusRed)
                    .disabled(sending)
                Button("Allow") { decide(true) }
                    .fontWeight(.medium)
                    .disabled(sending)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityLabel("Approval required")
    }
}
