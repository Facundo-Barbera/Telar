import Foundation

/// Mirror of `Session` in `packages/engine-client/src/protocol/entities.ts`.
///
/// Enums that appear in wire data decode with a FALLBACK rather than throwing:
/// the engine's unions grow, and a phone running last week's build must render
/// a session, not lose the list. Fields that are display-only stay `String`.

enum SessionActivity: String, Codable, Comparable {
    case blocked, working, queued, monitoring, idle

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionActivity(rawValue: raw) ?? .idle
    }

    /// The contract's order IS actionability — blocked outranks working
    /// because a sidebar answers "what needs me" first. Comparable so a list
    /// can sort by it directly.
    private var rank: Int {
        switch self {
        case .blocked: 0
        case .working: 1
        case .queued: 2
        case .monitoring: 3
        case .idle: 4
        }
    }

    static func < (lhs: SessionActivity, rhs: SessionActivity) -> Bool {
        lhs.rank < rhs.rank
    }
}

enum SessionState: String, Codable {
    case active, archived

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionState(rawValue: raw) ?? .active
    }
}

/// Flattened from the contract's discriminated union — `local` and `worktree`
/// share every field the phone reads, and a flat struct decodes both.
struct SessionWorkspace: Codable, Equatable {
    var mode: String
    var path: String
    var branch: String?
    var baseRef: String?
}

/// WHICH SESSION STARTED THIS ONE. Permanent, engine-stamped, never cleared —
/// provenance, not a lifetime, a permission or a cancellation path. `origin`
/// says an agent asked; this says who, which is the question a person reading a
/// list of conversations actually has.
struct SessionProvenance: Codable, Equatable {
    var sessionId: EngineID
    var runId: EngineID?
}

/// WHY THE ENGINE SHELVED A CONVERSATION — issue #378, and the mirror of
/// `SessionSettledBy` in packages/engine-client.
///
/// `settledOverride` used to mean one thing: a person decided. The Mac now
/// shelves a DELEGATE once its coordinator has taken delivery of the result,
/// and a shelf that hides a conversation the reader did not put there has to
/// say why — reconstructing it from an assignment list and a clock is not
/// something a phone should ask of anybody.
///
/// `kind` STAYS A `String`, like `SessionAssignment.outcome` beside it and for
/// the same reason: it is compared, never rendered, and a Mac newer than this
/// build may stamp a reason this one has never heard of. An enum would drop
/// the whole session record over a word.
struct SessionSettledBy: Codable, Equatable {
    var kind: String
    /// Who the work was for. A BARE id, meaningful only inside the engine that
    /// stamped it — resolve it on that Mac and nowhere else.
    var coordinatorSessionId: EngineID
    /// The errand, by its task run. Not read on the phone; carried so a row's
    /// hint and the Mac's own record cannot drift about which one this was.
    var runId: EngineID?
    var at: Timestamp?
}

/// WHAT A SESSION IS WORKING ON BEHALF OF — derived by the engine over each
/// session's whole queue and sent on the live list, so the rail learns who is
/// working for whom without a history read per row.
///
/// Mirror of `SessionAssignment` in packages/engine-client. `outcome` stays a
/// `String` because it is only ever compared, never rendered: absent is
/// outstanding, `detached` ended nothing, and anything else is finished.
struct SessionAssignment: Codable, Equatable {
    /// Who handed it over — engine-stamped, never from a tool argument. A bare
    /// id, and so only meaningful within the engine that stamped it.
    var fromSessionId: EngineID
    /// What the sender said it covers. Descriptive; confers nothing.
    var scope: String?
    var outcome: String?
    /// The carrying run is outside the records this was folded over, so its
    /// state is genuinely unknown. NOT outstanding — a paged-out completed
    /// carrier would otherwise look busy forever.
    var unresolved: Bool?
    /// WHEN THE WORK ARRIVED, and when it ended once it has — the two halves of
    /// "and when" that the Agents surface puts on a row (#390). The rail never
    /// needed them: an indent has no room for a date.
    ///
    /// OPTIONAL THOUGH THE CONTRACT MAKES `receivedAt` REQUIRED, like every
    /// other field on this struct. A row decoded through `Skippable` is DROPPED
    /// when a required field is missing, so declaring this one required would
    /// trade a missing timestamp for a missing relationship — and `receivedAt`
    /// is exactly the field an engine was once shipping as `undefined` (#380).
    var receivedAt: Timestamp?
    var endedAt: Timestamp?

    private enum CodingKeys: String, CodingKey { case fromSessionId, scope, outcome, unresolved, receivedAt, endedAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fromSessionId = try c.decode(EngineID.self, forKey: .fromSessionId)
        scope = try c.decodeIfPresent(String.self, forKey: .scope)
        outcome = try c.decodeIfPresent(String.self, forKey: .outcome)
        unresolved = try c.decodeIfPresent(Bool.self, forKey: .unresolved)
        receivedAt = try c.decodeIfPresent(Timestamp.self, forKey: .receivedAt)
        endedAt = try c.decodeIfPresent(Timestamp.self, forKey: .endedAt)
    }

    init(
        fromSessionId: EngineID, scope: String? = nil, outcome: String? = nil, unresolved: Bool? = nil,
        receivedAt: Timestamp? = nil, endedAt: Timestamp? = nil
    ) {
        self.fromSessionId = fromSessionId; self.scope = scope
        self.outcome = outcome; self.unresolved = unresolved
        self.receivedAt = receivedAt; self.endedAt = endedAt
    }
}

/// AN EXPLICIT, REVOCABLE, ONE-DIRECTIONAL WISH TO BE WOKEN — not a parent/child
/// link, and neither session's own record mentions the other. Mirror of
/// `Subscription` in packages/engine-client.
///
/// `targetSessionId` IS A BARE ID, so it only means anything inside the
/// subscriber's own engine: resolving one against every Mac's rows would pick a
/// stranger the moment two Macs minted the same session id.
struct Subscription: Codable, Equatable, Identifiable {
    var id: EngineID
    var subscriberSessionId: EngineID
    var targetSessionId: EngineID
}

struct Session: Codable, Identifiable, Equatable {
    var id: EngineID
    /// Absent is a positive statement (the Spool's project-less master chat),
    /// not an error.
    var projectId: EngineID?
    var title: String
    var state: SessionState
    var createdAt: Timestamp
    var updatedAt: Timestamp

    var driver: String
    /// The instance that routes this session's turns — what a model change
    /// must name when `model` is still nil (a fresh session).
    var resumeCursor: String? = nil
    var providerInstanceId: String?
    var model: ModelSelection?
    var workspace: SessionWorkspace
    var runtimeMode: String
    var detached: Bool

    var usage: UsageSnapshot?

    /// Server-derived; the phone must not re-derive it.
    var activity: SessionActivity
    var activityAt: Timestamp?
    var lastTurnEndedAt: Timestamp?
    var lastTurnFailed: Bool?

    /// IS THERE AN ANSWER NOBODY HAS READ — the pair, and the two halves are
    /// different kinds of thing (see `Session` in the contract).
    ///
    /// `lastTurnSequence` is DERIVED per read: the sequence of the newest turn
    /// that left a RESULT. `lastReadTurnSequence` is PERSISTED and only moves
    /// forward: the highest result a human was actually shown. Comparing the
    /// two is the whole of unread (`Settling.hasUnreadResult`) — no counter, no
    /// per-device bookkeeping, and the SAME answer on the phone and the Mac,
    /// which is the entire reason it is engine state rather than a local flag.
    ///
    /// BOTH OPTIONAL AND LENIENT, like every other field here: a Mac running an
    /// older build sends neither, and absent must mean "nothing to read" rather
    /// than "unknown" — the other reading would mark every row on that Mac
    /// unread forever.
    var lastTurnSequence: Int?
    var lastReadTurnSequence: Int?
    /// When the newest receipt landed. Only the inactivity baseline reads it;
    /// unread itself is decided on the sequences, never on a clock.
    var readAt: Timestamp?

    var settledOverride: String?
    var settledAt: Timestamp?
    /// WHY THE SHELF TOOK IT, when the ENGINE decided rather than a person —
    /// see `SessionSettledBy`. A settle somebody made needs no explanation;
    /// this is the one they did not make.
    var settledBy: SessionSettledBy?
    var snoozedUntil: Timestamp?
    var snoozedAt: Timestamp?

    /// Where this conversation came from — see `SessionProvenance`. The half of
    /// the rail's tree that never ends: a session started from another hangs
    /// under it for good, whether or not any work was ever assigned.
    var startedFrom: SessionProvenance?

    private enum CodingKeys: String, CodingKey {
        case id, projectId, title, state, createdAt, updatedAt, driver, model, providerInstanceId, resumeCursor
        case workspace, runtimeMode, detached, usage, activity, activityAt
        case lastTurnEndedAt, lastTurnFailed, settledOverride, settledAt, settledBy
        case snoozedUntil, snoozedAt, startedFrom
        case lastTurnSequence, lastReadTurnSequence, readAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        resumeCursor = try c.decodeIfPresent(String.self, forKey: .resumeCursor)
        id = try c.decode(EngineID.self, forKey: .id)
        projectId = try c.decodeIfPresent(EngineID.self, forKey: .projectId)
        title = try c.decode(String.self, forKey: .title)
        state = try c.decodeIfPresent(SessionState.self, forKey: .state) ?? .active
        createdAt = try c.decode(Timestamp.self, forKey: .createdAt)
        updatedAt = try c.decode(Timestamp.self, forKey: .updatedAt)
        driver = try c.decode(String.self, forKey: .driver)
        providerInstanceId = try c.decodeIfPresent(String.self, forKey: .providerInstanceId)
        model = try? c.decodeIfPresent(ModelSelection.self, forKey: .model)
        workspace = try c.decode(SessionWorkspace.self, forKey: .workspace)
        runtimeMode = try c.decodeIfPresent(String.self, forKey: .runtimeMode) ?? "approval-required"
        detached = try c.decodeIfPresent(Bool.self, forKey: .detached) ?? false
        usage = try? c.decodeIfPresent(UsageSnapshot.self, forKey: .usage)
        // zod fills the default at the engine's boundary; the wire may omit it.
        activity = try c.decodeIfPresent(SessionActivity.self, forKey: .activity) ?? .idle
        activityAt = try c.decodeIfPresent(Timestamp.self, forKey: .activityAt)
        lastTurnEndedAt = try c.decodeIfPresent(Timestamp.self, forKey: .lastTurnEndedAt)
        lastTurnFailed = try c.decodeIfPresent(Bool.self, forKey: .lastTurnFailed)
        settledOverride = try c.decodeIfPresent(String.self, forKey: .settledOverride)
        settledAt = try c.decodeIfPresent(Timestamp.self, forKey: .settledAt)
        // `try?` like every other nested shape here: a Mac newer than this
        // build may stamp a `kind` this one has never heard of, and losing a
        // hint is not a reason to drop the whole row.
        settledBy = try? c.decodeIfPresent(SessionSettledBy.self, forKey: .settledBy)
        snoozedUntil = try c.decodeIfPresent(Timestamp.self, forKey: .snoozedUntil)
        snoozedAt = try c.decodeIfPresent(Timestamp.self, forKey: .snoozedAt)
        startedFrom = try? c.decodeIfPresent(SessionProvenance.self, forKey: .startedFrom)
        lastTurnSequence = try c.decodeIfPresent(Int.self, forKey: .lastTurnSequence)
        lastReadTurnSequence = try c.decodeIfPresent(Int.self, forKey: .lastReadTurnSequence)
        readAt = try c.decodeIfPresent(Timestamp.self, forKey: .readAt)
    }
}

struct ProjectRef: Codable, Identifiable, Equatable, Hashable {
    var id: EngineID
    var name: String
    /// `Project.icon` — present when the engine found an icon file in the
    /// checkout. An opaque content-derived key: the bytes live behind
    /// `GET /api/projects/:id/icon?v=<icon>` and may be cached immutably
    /// against it, because a changed file is a changed key.
    var icon: String?
    /// `Project.iconName` — THE GLYPH A PERSON PICKED, which outranks the one
    /// above. One id out of the identity vocabulary (`TELAR_ICONS`), in lucide's
    /// own kebab-case; `telarIconSymbol` is what turns it into something this
    /// platform can draw. Absent means nobody has chosen one.
    var iconName: String?
    /// `Project.iconEmoji` — a mark typed before the picker existed (#364).
    /// Nothing writes it any more, and it is decoded rather than dropped
    /// because a registry written by an older cockpit still carries them.
    var iconEmoji: String?
    /// THE CHECKOUT'S PATH ON THAT MAC — the second line of a row in the
    /// new-conversation palette (#332), and the answer to "which of my two
    /// clones of this repo is that". Required by the contract's `Project`, so
    /// a Mac new enough to answer at all sends it; optional here because a
    /// phone must render a row from an older one rather than drop it.
    var root: String?
    /// `Project.remoteUrl` — WHICH REPOSITORY this project is a checkout of,
    /// already reduced by the engine to `host/owner/repo` (`normalizeRemote`,
    /// apps/engine/src/git.ts).
    ///
    /// THE ONE FACT ABOUT A PROJECT THAT IS TRUE ON MORE THAN ONE MAC. Project
    /// ids are minted per engine and names are whatever each person typed, so
    /// this is the only thing two Macs' registrations of the same work can be
    /// recognised by — see `SidebarModel.groupKey`.
    ///
    /// Absent on a project with no origin, on an unversioned directory, on a
    /// remote the engine could not reduce, and on a Mac too old to derive it.
    /// Absence is never treated as an answer: those projects keep the old
    /// per-Mac key rather than folding on their name.
    var remoteUrl: String?

    /// THE THREE ANSWERS TO "WHAT DOES THIS PROJECT LOOK LIKE", carried
    /// together — see `ProjectMark`. One value rather than three fields at every
    /// call site, so a surface that forwards a mark cannot forward two thirds of
    /// one.
    var mark: ProjectMark { ProjectMark(icon: icon, iconName: iconName, iconEmoji: iconEmoji) }
}

/// Mirror of `SidebarLayout` in packages/engine-client: where each project
/// group sits in the rail, and where each ROW sits inside one — `sessionOrder`
/// keyed by project group, `pinnedOrder` for the band.
///
/// ONE DOCUMENT PER MAC. That Mac's own cockpit, a browser tab on it and this
/// phone all draw from the same arrangement, which is exactly why a drop here
/// must send one field and re-read first: a phone writing the whole document
/// from a copy it loaded a minute ago would resurrect the order a drag on the
/// Mac had replaced in between.
///
/// THE KEYS ARE THE WRITING COCKPIT'S. For a Mac's own projects and sessions
/// they are the bare ids, which is what this phone holds for that Mac's rows
/// too. A group that Mac pairs from ANOTHER Mac is keyed `hostId:projectId`
/// with a host id this phone cannot mint — so those entries never match here,
/// rather than matching the wrong row.
///
/// EVERY FIELD DEFAULTS: a document written before the row arrangements
/// existed means "nobody has arranged any rows", not "this is broken".
struct SidebarLayout: Decodable, Equatable, Sendable {
    var projectOrder: [String] = []
    var sessionOrder: [String: [String]] = [:]
    var pinnedOrder: [String] = []

    init(projectOrder: [String] = [], sessionOrder: [String: [String]] = [:], pinnedOrder: [String] = []) {
        self.projectOrder = projectOrder
        self.sessionOrder = sessionOrder
        self.pinnedOrder = pinnedOrder
    }

    private enum CodingKeys: String, CodingKey { case projectOrder, sessionOrder, pinnedOrder }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projectOrder = try c.decodeIfPresent([String].self, forKey: .projectOrder) ?? []
        sessionOrder = try c.decodeIfPresent([String: [String]].self, forKey: .sessionOrder) ?? [:]
        pinnedOrder = try c.decodeIfPresent([String].self, forKey: .pinnedOrder) ?? []
    }
}

/// `GET /api/sessions/live` — the whole inbox in one call.
///
/// ROWS, NOT WHOLE SESSIONS (#459). The Mac sends `LiveSessionRow`: every field
/// a rail draws and none it does not. The record below is the union of that and
/// the fuller one `GET /api/sessions/:id` answers with, so this one type reads
/// both — every field the list omits was already optional here, and absent goes
/// on meaning the engine's own default rather than "unknown". Do NOT make a
/// field required to satisfy the session screen: that screen has its own read,
/// and a required field the list does not send blanks the whole list.
struct LiveSessions: Decodable {
    var sessions: [Session]
    var projects: [ProjectRef]
    /// The rail's arrangement, riding the read the phone already makes every
    /// few seconds — which is how a drag on the Mac reaches this phone without
    /// a request, a timer or a connection of its own. Nil from a Mac whose
    /// engine predates the field; the sidebar then falls back to asking for it
    /// directly, once a minute.
    var layout: SidebarLayout?
    /// WHO EACH SESSION IS WORKING FOR, by session id — folded by the ENGINE
    /// over each session's whole queue and sent on this same list, so the rail's
    /// tree costs no extra request and no per-row history read on any poll.
    ///
    /// EMPTY IS THE ORDINARY ANSWER, not a failure: most sessions were nobody's
    /// delegate, and a cockpit too old to forward the field sends none at all.
    /// The rail then draws exactly the flat list it always did.
    var assignments: [EngineID: [SessionAssignment]] = [:]
    /// THE SETTLING WINDOW THESE ROWS BAND BY — that Mac's own, riding the read
    /// the phone already makes (#459). It used to be a second request, rationed
    /// to once a minute because against a slow Mac an extra call per poll is
    /// what keeps the list a poll behind; now it costs nothing and is never
    /// stale. Nil from a Mac whose engine predates the field, and the store then
    /// falls back to asking for it directly, on the same ration as before.
    var inbox: InboxPolicy?
    /// WHAT TO ASK WITH NEXT TIME — the conditional read's cursor (#459). Nil
    /// from a Mac too old to count, which simply keeps every read a full one.
    var revision: Int?
    /// NOTHING HAS MOVED SINCE THE CURSOR THIS PHONE SENT, so this answer
    /// carries no rows at all and the store keeps what it has.
    ///
    /// CHECK IT BEFORE READING `sessions`. The two arrays below decode to empty
    /// rather than throwing on an answer that omits them, which is what makes
    /// this type read both shapes — and which is exactly why "unchanged" must
    /// never be confused with "this Mac has no conversations".
    var unchanged: Bool = false

    private enum CodingKeys: String, CodingKey { case sessions, projects, layout, assignments, inbox, revision, unchanged }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A policy this build cannot read costs the window, never the list.
        inbox = try? c.decodeIfPresent(InboxPolicy.self, forKey: .inbox)
        revision = try? c.decodeIfPresent(Int.self, forKey: .revision)
        unchanged = (try? c.decode(Bool.self, forKey: .unchanged)) ?? false
        sessions = try c.decodeIfPresent([Skippable<Session>].self, forKey: .sessions)?.compactMap(\.value) ?? []
        projects = try c.decodeIfPresent([Skippable<ProjectRef>].self, forKey: .projects)?.compactMap(\.value) ?? []
        // A layout this build cannot read costs the arrangement, never the
        // list — the same tolerance `Skippable` gives the rows above.
        layout = try? c.decodeIfPresent(SidebarLayout.self, forKey: .layout)
        // And an assignment map it cannot read costs the tree, never the list.
        assignments = (try? c.decodeIfPresent([EngineID: [Skippable<SessionAssignment>]].self, forKey: .assignments))?
            .mapValues { $0.compactMap(\.value) } ?? [:]
    }
}
