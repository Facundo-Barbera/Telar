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
    /// FOCUS LIVES HERE, exactly as it does on `SessionView`: the transcript is
    /// what puts the keyboard away, and it cannot reach a flag private to the
    /// composer.
    @State private var composerFocused = false
    /// The described catalogue behind the composer's first pill — names,
    /// families, context limits and the endpoint each id answers on, plus the
    /// service's own words when a half of it could not be read (#551).
    @State private var catalogue = AgentModelList(models: [], message: nil)
    /**
     STICK TO THE BOTTOM, THE WAY `SessionView` DOES (#539).

     This screen opened at the TOP. It scrolled to a bottom anchor only
     `onChange(of: rows.count)`, which misses the case that matters: the first
     page arrives in one assignment before the view has laid out, and every
     RE-OPEN starts with the rows already in hand, so the count never changes
     and the anchor is never used. A person opening the Agent read the oldest
     thing it had ever said.

     `.scrollPosition` pinned to an EDGE is the fix and is the transcript's own
     (`SessionView`): a position pinned to an edge stays on that edge as the
     content grows, and `isPositionedByUser` flips the moment the reader
     scrolls — which is what "let them go" keys on. `.defaultScrollAnchor`
     cannot do this job; it is solved once, when the ScrollView first appears,
     and this transcript is still empty then.
     */
    @State private var scroll = AgentTranscriptScroll()

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
                    // IT NAMES A SCREEN ON THIS PHONE NOW (#556). It used to send
                    // the reader to find a desktop, which was the honest answer
                    // while the phone had nowhere to set this; it has an Agent
                    // screen of its own under the Mac, so the sentence points
                    // there rather than off the device.
                    description: Text("Its switch, key, model and defaults are in Settings ▸ that Mac ▸ Agent — here, or in Telar on the Mac itself.")
                )
            } else {
                // THE CONTEXT METER, AS ONE LINE UNDER THE HEADER (#539). The
                // Agent reported no context at all, and a coordinator whose
                // history is quietly being trimmed is one a person cannot reason
                // about. It draws nothing until a turn has ended, so a fresh
                // thread is not topped with an empty gauge, and nothing at all
                // against a Mac too old to send the numbers.
                if let meter = state?.lastUsage, let line = meter.meterLine {
                    contextLine(meter, line)
                }
                transcript
                composer
            }
        }
        .navigationTitle("Agent")
        .navigationBarTitleDisplayMode(.inline)
        .task { await follow() }
    }

    // ── THE CONTEXT METER ────────────────────────────────────────────────────

    /// ONE LINE, NOT A CARD. It sits between the navigation bar and the
    /// transcript, where a masthead's meter would be on the desktop, and it is
    /// the quietest thing on the screen until the conversation gets crowded —
    /// at which point the bar takes the warning tone, because the Mac's trim
    /// drops history SILENTLY and the warning has to arrive before anything has
    /// been lost rather than after.
    private func contextLine(_ meter: AgentLastUsage, _ line: String) -> some View {
        let crowded = meter.percent >= 80
        return HStack(spacing: 8) {
            Spacer(minLength: 0)
            // A LEVEL, DRAWN AS ONE. `ProgressView` would say something is in
            // progress; nothing is.
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.surface)
                    Capsule()
                        .fill(crowded ? Theme.statusAmber : Theme.textMuted)
                        .frame(width: geometry.size.width * CGFloat(meter.percent) / 100)
                }
            }
            .frame(width: 40, height: 4)
            Text(line)
                .font(Theme.monoSmall)
                .foregroundStyle(crowded ? Theme.statusAmber : Theme.textMuted)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Context used")
        .accessibilityValue(line)
    }

    // ── THE TRANSCRIPT ───────────────────────────────────────────────────────

    private var transcript: some View {
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
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .scrollPosition($scroll.position)
        // THE CONVERSATION IS THE WAY OUT OF THE KEYBOARD — the transcript's own
        // rule on `SessionView`, and the composer is a real field now, so this
        // screen needs it too.
        .scrollDismissesKeyboard(.immediately)
    }


    /// WHAT IS WORTH DRAWING.
    ///
    /// `turn_started` says nothing the user message above it does not, and the
    /// two request rows are the history of a decision whose card is live state
    /// — so all three are dropped rather than rendered as empty lines in the
    /// middle of a conversation.
    ///
    /// A COMPLETED `turn_done` IS DROPPED TOO, and that is the one worth
    /// stating because it looks like a field going unused. It carries the FINAL
    /// assistant text, deliberately duplicating the last `assistant_message`
    /// row: it is there for a reader that wants one answer per turn without
    /// folding the log. This screen folds the log, so drawing both would print
    /// the closing sentence of every turn twice.
    private var drawn: [AgentRow] {
        rows.filter { row in
            switch row.kind {
            case .turnStarted, .requestOpened, .requestResolved: return false
            case .assistantMessage, .userMessage: return !(row.text ?? "").isEmpty
            // Only the two ways a turn ends without an answer.
            case .turnDone: return row.status != "completed"
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

    /// THE SESSION'S COMPOSER, NOT A SECOND ONE (#539).
    ///
    /// This was a bare `TextField` with a send button, because `ComposerView`
    /// took a `SessionStore` and the Agent is not a session. What the Agent was
    /// missing was not decoration: `ComposerTextView` is a UIKit field, which is
    /// the only reason the system's own Paste offers a picture at all, and the
    /// focused card, the stash and the control row came with it.
    ///
    /// `ComposerHost` is what made it reusable — the composer names the handful
    /// of facts it reads rather than a store, and `AgentComposerHost` answers
    /// them, including the two honest noes: no attachments (the thread route
    /// takes `{ text }` and has nowhere to put bytes) and no queue strip (the
    /// engine reports how MANY turns are queued, not what they say).
    private var composer: some View {
        ComposerView(
            draft: $draft,
            focus: $composerFocused,
            host: AgentComposerHost(
                running: state?.running == true,
                onSend: { text in await send(text) },
                onStop: { await cancel() }
            ),
            // THE ONE CALL THE BOX MAKES THAT IS NOT ABOUT A CONVERSATION
            // (#544): a dictation token is machine-scoped, so the client is
            // handed in rather than reached through `ComposerHost` — that
            // protocol names what the box reads about THIS conversation, and a
            // token is not one of those.
            api: api,
            // THE THREE CONTROLS, BOUND TO `/v2/agent` — item 1's row of menus
            // above the composer, which on this phone is the composer's own
            // toolbar rather than a second row above it.
            controls: AnyView(
                AgentComposerControls(
                    state: state,
                    catalogue: catalogue,
                    onPatch: { patch in await configure(patch) }
                )
            ),
            onSend: { scroll.pinToTail() }
        )
    }

    // ── READS AND WRITES ─────────────────────────────────────────────────────

    /// Page the transcript once, then keep asking from the cursor.
    private func follow() async {
        await refreshState()
        await loadModels()
        await page()
        loading = false
        // AFTER THE FIRST PAGE, AND ON EVERY RE-OPEN. This is the case the old
        // `onChange(of: rows.count)` anchor could not reach: the first page
        // lands in one assignment before layout, and a re-open starts with the
        // rows already in hand, so the count never changes. See `scroll`.
        scroll.rowsChanged(to: rows.count)
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(Self.pollSeconds))
            if Task.isCancelled { return }
            await refreshState()
            await page()
            // NEW ROWS FOLLOW THE TAIL; a reader who scrolled up keeps their
            // place, because `rowsChanged` only pins when the count moved.
            scroll.rowsChanged(to: rows.count)
        }
    }

    /// THE MODEL PILL'S LIST — `GET /v2/agent/models`, once per screen.
    ///
    /// FAILS SOFT, like the desktop's: an empty picker carrying the service's
    /// own words beats one full of ids that 404, and the pane is opened before
    /// the key is pasted at least as often as after.
    private func loadModels() async {
        guard let answer = try? await api.agentModels() else { return }
        catalogue = answer
    }

    /// THE THREE PILLS WRITE HERE — the same `PATCH /v2/agent` the Mac's own
    /// Settings uses, so the phone and the desktop read one value. The answer is
    /// the new state, so a refusal shows as a refusal rather than as a setting
    /// that silently reverted on the next poll.
    private func configure(_ patch: AgentSettingsPatch) async {
        do {
            state = try await api.setAgent(patch).agent
            failure = nil
        } catch {
            failure = "That Mac refused the setting."
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

    /// The composer hands the text over; it has already cleared the box and
    /// pinned the transcript, which is `ComposerView`'s own contract.
    private func send(_ raw: String) async {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        defer { sending = false }
        do {
            let accepted = try await api.sendAgentTurn(text)
            if let agent = accepted.agent { state = agent }
            await page()
            scroll.rowsChanged(to: rows.count)
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
///
/// THE SAME VIEWS `SessionView` DRAWS (#539). This screen had its own bubble and
/// its own hand-rolled tool disclosure, one radius and one font off the
/// transcript beside it — two conversations on one phone that did not look like
/// the same app. `UserBubble` and `ToolChipLabel`/`NestedDetail` are the
/// session transcript's own and take no store, so the Agent uses them outright;
/// the assistant already shared `MarkdownText`.
///
/// WHAT STAYS THE AGENT'S OWN is the wake label above a user bubble, because
/// the session's equivalent (`WakeRow`) reads a `JournalTurn` the Agent has no
/// shape for — and the fact it states is the same one either way.
struct AgentRowView: View {
    let row: AgentRow
    @State private var open = false

    /// The Agent writes its tool status as a string; the session's chip takes
    /// the journal's enum. Same three states, one translation, no third
    /// vocabulary — and an unknown one draws no mark rather than guessing.
    private var toolStatus: ItemStatus? {
        switch row.status {
        case "failed": return .failed
        case "declined": return .declined
        case "completed": return .completed
        default: return nil
        }
    }

    var body: some View {
        switch row.kind {
        case .userMessage:
            VStack(alignment: .trailing, spacing: 4) {
                if let wake = row.wakeLabel {
                    Text(wake).font(Theme.monoSmall).foregroundStyle(Theme.textMuted)
                }
                UserBubble(text: row.text ?? "")
            }
            .frame(maxWidth: .infinity, alignment: .trailing)

        case .assistantMessage:
            MarkdownText(text: row.text ?? "").frame(maxWidth: .infinity, alignment: .leading)

        case .turnDone:
            // A PERSON WHO PRESSED STOP KNOWS WHY THE TURN ENDED. One that fell
            // over owes them the sentence. A COMPLETED turn reaches here only
            // if `drawn` let it through, and it never does — its text is
            // already on an `assistant_message` row.
            Label(
                row.status == "stopped" ? "Stopped." : (row.text ?? "The turn failed."),
                systemImage: row.status == "stopped" ? "stop.circle" : "exclamationmark.triangle"
            )
            .font(.footnote)
            .foregroundStyle(row.status == "stopped" ? Theme.textMuted : Theme.statusRed)

        case .toolCall:
            // ONE LINE UNTIL IT IS ASKED TO BE MORE. The Agent's tools are the
            // sessions and notes walls — reads that answer in paragraphs — and a
            // conversation that printed every answer in full would be
            // unreadable on a phone.
            VStack(alignment: .leading, spacing: 6) {
                Button { open.toggle() } label: {
                    // THE SESSION'S OWN CHIP — same glyph slot, same mono
                    // label, same status marks (a pulse while running, a cross
                    // for failed, a raised hand for declined).
                    ToolChipLabel(
                        icon: open ? "chevron.down" : "chevron.right",
                        label: displayToolName(row.name ?? "tool"),
                        status: toolStatus
                    )
                }
                .buttonStyle(.plain)
                // And the session's own nesting: a 28pt indent behind a left
                // hairline, rather than a bare padding.
                if open, let output = row.output, !output.isEmpty {
                    NestedDetail {
                        Text(output)
                            .font(Theme.monoSmall)
                            .foregroundStyle(Theme.textMuted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
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
