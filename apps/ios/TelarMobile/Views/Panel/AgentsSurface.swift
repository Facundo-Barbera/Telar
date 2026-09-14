import SwiftUI

/// THE AGENTS TAB — who is working for this conversation, and who it is working
/// for. Issue #390, and the phone's half of #381.
///
/// The rail used to state the relationship with an indent: a session somebody
/// had handed work to was drawn as a child row under the one that handed it
/// over, which read as a sub-agent of it. It is not one — they are separate
/// conversations — so the indent went, and with it went the only place the
/// phone said anything about the relationship at all. This is where it moved,
/// the same two sections the Mac has (`related-conversations.tsx`).
///
/// FOUR RELATIONSHIPS, STILL NOT MERGED:
///
///   assigned    outstanding work on this conversation's behalf; it ENDS
///   finished    the errand is over — the result this conversation delegated for
///   started     started from here; permanent, and ends nothing
///   followed    a revocable wish to be woken, and nothing more
///
/// None confers permission and none is a lifetime.
///
/// ONE MAC, THROUGHOUT. The desktop has to scope every id comparison by host
/// because its rail holds several Macs at once; this surface is handed ONE
/// engine's api — the one the session being read lives on — so every id here is
/// already that engine's and nothing else can reach it. That is why the
/// derivations below take bare ids where the Mac's take a host-qualified key.

/// How a conversation is related to the one being read. The order is the order
/// the rows are drawn in, and it is the order the tree sorted in too.
enum AgentRelation: String, Equatable {
    case assigned, finished, started, followed
}

/// A conversation working for this one.
struct RelatedDelegate: Identifiable, Equatable {
    var session: Session
    var kind: AgentRelation
    /// What the coordinator said the errand covers. Descriptive; confers nothing.
    var scope: String?
    /// `SessionAssignment.outcome` verbatim — compared, never trusted to be one
    /// of a closed set, for the reason the model keeps it a `String`.
    var outcome: String?
    /// When the relationship was last stamped — handed over, ended, or started.
    var at: Timestamp?
    /// EVERY subscription this conversation holds on the row, which is what an
    /// unfollow would have to remove: a target can be followed twice. Empty on
    /// a row nobody is watching.
    var subscriptionIds: [EngineID]
    var id: EngineID { session.id }
}

/// An errand this conversation was handed, and who handed it over.
struct RelatedCoordinator: Identifiable, Equatable {
    /// The coordinator's own row, when the live list still holds it. One that
    /// has been archived is absent — the row then names it by id rather than by
    /// nothing, and offers no way in.
    var session: Session?
    var sessionId: EngineID
    var scope: String?
    var outcome: String?
    /// Ended at, or handed over at while it has not.
    var at: Timestamp?
    /// Outstanding, and not merely un-ended: an `unresolved` assignment's
    /// carrier is gone, so its state is unknown rather than live.
    var outstanding: Bool
    var unresolved: Bool
    var id: String
}

/// The outstanding errand from one coordinator — not the first historical one
/// that happened to carry a scope, which would show a row the words of a task
/// it finished last week.
private func outstandingFrom(_ assignments: [SessionAssignment]?, _ coordinatorId: EngineID) -> SessionAssignment? {
    assignments?.first { $0.fromSessionId == coordinatorId && $0.outcome == nil && $0.unresolved != true }
}

/// The most recent ENDED errand from one coordinator. `assignments` is newest
/// last, so the last match is the one the row is reporting.
private func endedFrom(_ assignments: [SessionAssignment]?, _ coordinatorId: EngineID) -> SessionAssignment? {
    assignments?.last { $0.fromSessionId == coordinatorId && $0.outcome != nil && $0.outcome != "detached" }
}

/// THE CONVERSATIONS WORKING FOR THIS ONE — the Mac's `delegatesOf`.
///
/// ONE ROW PER CONVERSATION, whatever else is true of it. A session that is
/// running an errand AND is followed is one relationship to a reader and two
/// facts about it; the strongest relationship names the row and the
/// subscriptions ride along, which is what keeps a future unfollow control on
/// the row it belongs to rather than on a duplicate underneath.
func delegatesOf(
    _ sessions: [Session],
    assignments: [EngineID: [SessionAssignment]],
    coordinator coordinatorId: EngineID,
    following: [Subscription] = []
) -> [RelatedDelegate] {
    var assigned: [Session] = [], finished: [Session] = [], started: [Session] = []
    for session in sessions where session.id != coordinatorId {
        let mine = (assignments[session.id] ?? []).filter { $0.fromSessionId == coordinatorId }
        if mine.contains(where: { $0.outcome == nil && $0.unresolved != true }) {
            assigned.append(session)
        } else if mine.contains(where: { $0.outcome != nil && $0.outcome != "detached" }) {
            finished.append(session)
        } else if session.startedFrom?.sessionId == coordinatorId {
            started.append(session)
        }
    }

    // WHICH SESSIONS THIS ONE IS WATCHING, deduplicated: a target followed
    // twice (two subscriptions, or a one-shot beside a standing one) is one row
    // carrying both ids, never two rows.
    var follows: [EngineID: [EngineID]] = [:]
    var watched: [EngineID] = []
    for subscription in following {
        guard sessions.contains(where: { $0.id == subscription.targetSessionId }) else { continue }
        if follows[subscription.targetSessionId] == nil { watched.append(subscription.targetSessionId) }
        follows[subscription.targetSessionId, default: []].append(subscription.id)
    }

    var out: [RelatedDelegate] = []
    var seen: Set<EngineID> = [coordinatorId]
    func add(_ session: Session, _ kind: AgentRelation, scope: String? = nil, outcome: String? = nil, at: Timestamp? = nil) {
        guard !seen.contains(session.id) else { return }
        seen.insert(session.id)
        out.append(RelatedDelegate(session: session, kind: kind, scope: scope, outcome: outcome, at: at,
                                   subscriptionIds: follows[session.id] ?? []))
    }

    for session in assigned {
        let errand = outstandingFrom(assignments[session.id], coordinatorId)
        add(session, .assigned, scope: errand?.scope, at: errand?.receivedAt)
    }
    for session in finished {
        let errand = endedFrom(assignments[session.id], coordinatorId)
        add(session, .finished, scope: errand?.scope, outcome: errand?.outcome, at: errand?.endedAt)
    }
    for session in started {
        add(session, .started, at: session.createdAt)
    }
    for id in watched {
        guard let session = sessions.first(where: { $0.id == id }) else { continue }
        add(session, .followed)
    }
    return out
}

/// THE CONVERSATIONS THIS ONE IS WORKING FOR — the inverse, and the whole of
/// it: `assignments` is exactly "who handed me work", engine-stamped.
///
/// OUTSTANDING FIRST, then the finished ones newest-first. A detached errand is
/// dropped: "continue independently" is the reader saying this is nobody's work
/// any more, and listing it here would be the panel disagreeing.
func coordinatorsOf(
    _ sessions: [Session],
    assignments: [EngineID: [SessionAssignment]],
    of sessionId: EngineID
) -> [RelatedCoordinator] {
    let held = (assignments[sessionId] ?? []).filter { $0.outcome != "detached" }
    return held.enumerated().map { index, assignment in
        let at = assignment.endedAt ?? assignment.receivedAt
        return RelatedCoordinator(
            session: sessions.first { $0.id == assignment.fromSessionId },
            sessionId: assignment.fromSessionId,
            scope: assignment.scope,
            outcome: assignment.outcome,
            at: at,
            outstanding: assignment.outcome == nil && assignment.unresolved != true,
            unresolved: assignment.unresolved == true,
            // The list may hold two errands from one coordinator, and an
            // engine may not have stamped either with a time — so the row's
            // own position is part of its identity.
            id: "\(index):\(assignment.fromSessionId)"
        )
    }
    // Paired with its position, because Swift's sort is not stable and two
    // errands handed over in the same millisecond must not swap between polls.
    .enumerated().sorted { a, b in
        if a.element.outstanding != b.element.outstanding { return a.element.outstanding }
        let (left, right) = (a.element.at ?? 0, b.element.at ?? 0)
        return left == right ? a.offset < b.offset : left > right
    }.map(\.element)
}

// ── what a row says ────────────────────────────────────────────────────────

/// The register a row's trailing word is in — the Mac's `PanelTone`, kept as a
/// value rather than a `Color` so the decision can be put to a test without a
/// view. `AgentsSurface.color` is the only thing that turns one into paint.
enum AgentTone: Equatable {
    case live, attention, done, danger, quiet
}

/// `SessionAssignment.outcome` as a word, or the engine's own if this build has
/// never heard of it — the model keeps the field a `String` precisely so a Mac
/// newer than this one can stamp something new without costing the row.
func outcomeLabel(_ outcome: String) -> String {
    switch outcome {
    case "completed": "Done"
    case "failed": "Failed"
    case "stopped": "Stopped"
    case "detached": "Detached"
    default: outcome
    }
}

func outcomeTone(_ outcome: String) -> AgentTone {
    switch outcome {
    case "completed": .done
    case "failed": .danger
    default: .quiet
    }
}

/// WHAT A DELEGATE ROW REPORTS, and in which register.
///
/// A LIVE ROW REPORTS ITS OWN ACTIVITY; a finished one reports the OUTCOME.
/// They are different facts and the row has one trailing word, so the choice
/// matters: "Done" on a session that has since started something else would be
/// the panel describing the errand while the reader is looking at the
/// conversation, and "Idle" on a delegate whose result is waiting would be the
/// reverse.
func delegateState(_ entry: RelatedDelegate) -> (label: String, tone: AgentTone) {
    if entry.kind == .finished, let outcome = entry.outcome {
        return (outcomeLabel(outcome), outcomeTone(outcome))
    }
    switch entry.session.activity {
    case .blocked: return ("Needs you", .attention)
    case .working: return ("Working", .live)
    case .queued: return ("Queued", .live)
    case .monitoring: return ("Monitoring", .live)
    // An outstanding errand is work in hand even on a session between turns,
    // so "Idle" there would contradict the section the row is sitting in.
    case .idle: return (entry.kind == .assigned ? "Working" : "Idle", .quiet)
    }
}

/// The second line: which errand, and when. Absent where there is neither.
func delegateDetail(_ entry: RelatedDelegate, now: Timestamp) -> String? {
    var parts: [String] = []
    if let scope = entry.scope, !scope.isEmpty { parts.append(scope) }
    else if entry.kind == .started { parts.append("started from here") }
    else if entry.kind == .followed { parts.append("following") }
    if let at = entry.at { parts.append(relativeTime(at)) }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
}

/// The inverse row's word, and it is NOT a mirror: a delegate has one thing to
/// say — who asked, for what, and whether it is still owed.
func coordinatorState(_ entry: RelatedCoordinator) -> (label: String, tone: AgentTone) {
    if let outcome = entry.outcome { return (outcomeLabel(outcome), outcomeTone(outcome)) }
    if entry.unresolved { return ("Unknown", .quiet) }
    return ("Working for", entry.outstanding ? .live : .quiet)
}

func coordinatorDetail(_ entry: RelatedCoordinator) -> String? {
    var parts: [String] = []
    if let scope = entry.scope, !scope.isEmpty { parts.append(scope) }
    if entry.unresolved { parts.append("state unknown") }
    if let at = entry.at { parts.append(relativeTime(at)) }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
}

// ── the surface ────────────────────────────────────────────────────────────

struct AgentsSurface: View {
    let api: any EngineAPI
    let sessionId: EngineID
    /// Which Mac this conversation lives on — what a row needs to be openable
    /// at all, because a bare session id addresses nothing on a phone holding
    /// two Macs. Nil outside the split view's own routing; the rows then say
    /// what they say and simply do not open.
    let hostId: HostID?
    /// The turn's activity — a settling turn re-reads, like every other
    /// surface. It is not enough on its own; see `poll`.
    let active: Bool

    @State private var sessions: [Session] = []
    @State private var assignments: [EngineID: [SessionAssignment]] = [:]
    @State private var following: [Subscription] = []
    @State private var loaded = false
    @State private var failed = false
    @Environment(\.openURL) private var openURL

    /// HOW OFTEN A DELEGATE'S STATE IS RE-READ. A worker finishing an errand
    /// writes nothing to the journal this panel is mounted beside, so a surface
    /// that only re-read on its own turn boundary would show a running delegate
    /// forever — which is the Mac's reason for polling too. Ten seconds is the
    /// idle cadence the inbox already uses against the same route.
    private static let poll = Duration.seconds(10)

    private var delegates: [RelatedDelegate] {
        delegatesOf(sessions, assignments: assignments, coordinator: sessionId, following: following)
    }
    private var employers: [RelatedCoordinator] {
        coordinatorsOf(sessions, assignments: assignments, of: sessionId)
    }

    var body: some View {
        ScrollView {
            let delegates = delegates, employers = employers
            if delegates.isEmpty && employers.isEmpty {
                empty
            } else {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if !delegates.isEmpty {
                        section("Working for this conversation", count: delegates.count)
                        ForEach(delegates) { entry in delegateRow(entry) }
                    }
                    if !employers.isEmpty {
                        section("Working for", count: employers.count)
                        ForEach(employers) { entry in employerRow(entry) }
                    }
                }
                .padding(.bottom, 12)
            }
        }
        .refreshable { await read() }
        // The id restarts the loop when the turn settles, so the reader sees
        // the answer without waiting out the current interval.
        .task(id: "\(sessionId):\(active)") {
            while !Task.isCancelled {
                await read()
                try? await Task.sleep(for: Self.poll)
            }
        }
    }

    @ViewBuilder private var empty: some View {
        // NOTHING AT ALL UNTIL THE FIRST ANSWER. "No other conversation is
        // involved" before the read lands is a claim made from silence, and on
        // a coordinator it is the wrong one.
        if loaded {
            ContentUnavailableView(
                "No other conversation is involved",
                systemImage: "person.2",
                description: Text(failed
                    ? "The Mac did not answer — retrying."
                    : "Conversations this one hands work to appear here, with what they were asked for and how it went.")
            )
            .padding(.top, 24)
        }
    }

    private func section(_ label: String, count: Int) -> some View {
        HStack(spacing: 6) {
            Text(label)
            Text("\(count)").monospacedDigit()
        }
        .bandCaption()
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .padding(.bottom, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label), \(count)")
    }

    /// A ROW IS A LINK WHERE IT CAN BE ONE. Opening the conversation is the
    /// whole point of the surface, and the route is the deep link the phone
    /// already routes to itself (`ScopedSessionID.url`, handled by `RootView`)
    /// — so a tap lands in the same place a notification's would, rather than
    /// through a second navigation path that has to be kept in step.
    @ViewBuilder private func delegateRow(_ entry: RelatedDelegate) -> some View {
        let state = delegateState(entry)
        row(
            title: entry.session.title.isEmpty ? "Untitled session" : entry.session.title,
            detail: delegateDetail(entry, now: now),
            state: state,
            activity: entry.kind == .finished && entry.outcome != nil ? nil : entry.session.activity,
            open: destination(entry.session.id)
        )
    }

    @ViewBuilder private func employerRow(_ entry: RelatedCoordinator) -> some View {
        let title = entry.session?.title.isEmpty == false
            ? entry.session!.title
            : "Conversation \(entry.sessionId.prefix(8))"
        // NO LINK WITHOUT A ROW. The coordinator has been archived — the live
        // list does not carry it — and a link built from a bare id would open
        // a session the engine will answer "not found" about.
        let detail = [coordinatorDetail(entry), entry.session == nil ? "no longer listed" : nil]
            .compactMap { $0 }.joined(separator: " · ")
        row(
            title: title,
            detail: detail.isEmpty ? nil : detail,
            state: coordinatorState(entry),
            activity: entry.session?.activity,
            open: entry.session.flatMap { destination($0.id) }
        )
    }

    @ViewBuilder private func row(
        title: String, detail: String?, state: (label: String, tone: AgentTone),
        activity: SessionActivity?, open: URL?
    ) -> some View {
        let body = HStack(alignment: .top, spacing: 8) {
            // THE RAIL'S OWN STATUS DOT (`ActivityBadge`), not a second
            // vocabulary for the same fact: amber is asking for something, sky
            // is live, a faded dot is at rest.
            if let activity {
                ActivityBadge(activity: activity).padding(.top, 4)
            } else {
                Circle().fill(color(state.tone)).frame(width: 7, height: 7).padding(.top, 4)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13)).foregroundStyle(Theme.text)
                    .lineLimit(1).truncationMode(.tail)
                if let detail {
                    Text(detail).font(.system(size: 11)).foregroundStyle(Theme.textMuted)
                        .lineLimit(1).truncationMode(.tail)
                }
            }
            Spacer(minLength: 4)
            Text(state.label)
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .foregroundStyle(color(state.tone))
                .layoutPriority(-1)
            if open != nil {
                Image(systemName: "arrow.up.right").font(.system(Theme.captionTiny)).foregroundStyle(Theme.textMuted)
                    .padding(.top, 2)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .contentShape(Rectangle())

        if let open {
            Button { openURL(open) } label: { body }
                .buttonStyle(.plain)
                .accessibilityHint("Opens this conversation")
        } else {
            body
        }
    }

    private func destination(_ id: EngineID) -> URL? {
        hostId.map { ScopedSessionID(hostId: $0, sessionId: id).url }
    }

    private var now: Timestamp { Timestamp(Date().timeIntervalSince1970 * 1000) }

    private func color(_ tone: AgentTone) -> Color {
        switch tone {
        case .live: Theme.statusSky
        case .attention: Theme.statusAmber
        case .done: Theme.statusEmerald
        case .danger: Theme.statusRed
        case .quiet: Theme.textMuted
        }
    }

    /// THE TWO READS the Mac makes, against the one Mac this session lives on.
    ///
    /// `liveSessions` is the pool — the one route that carries `assignments`,
    /// folded by the engine over every session's whole queue — and
    /// `subscriptions` is this conversation's own, read for the ONE session
    /// being looked at rather than for a set of rows (which is what made the
    /// rail's version a request per poll for nobody, #381).
    ///
    /// A FAILED READ PRESERVES THE LAST GOOD ANSWER. An empty list claims
    /// nobody is working here, and a dropped request is not evidence of that.
    ///
    /// AND IT ASKS FOR ALL OF THEM (#457). The live route answers the unsettled
    /// rows by default, which is right for a RAIL and wrong here: a delegate is
    /// settled precisely BECAUSE its work was delivered, so the narrow list
    /// would drop the finished agents this surface exists to show. It is a read
    /// per open panel rather than a poll per rail, which is what makes paying
    /// for the whole list the right trade in this one place.
    private func read() async {
        let list = try? await api.liveSessions(all: true)
        let subscriptions = try? await api.sessionSubscriptions(sessionId)
        if let list {
            sessions = list.sessions
            assignments = list.assignments
        }
        if let subscriptions { following = subscriptions }
        failed = list == nil
        loaded = true
    }
}
