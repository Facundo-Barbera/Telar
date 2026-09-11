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
    var snoozedUntil: Timestamp?
    var snoozedAt: Timestamp?

    private enum CodingKeys: String, CodingKey {
        case id, projectId, title, state, createdAt, updatedAt, driver, model, providerInstanceId, resumeCursor
        case workspace, runtimeMode, detached, usage, activity, activityAt
        case lastTurnEndedAt, lastTurnFailed, settledOverride, settledAt
        case snoozedUntil, snoozedAt
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
        snoozedUntil = try c.decodeIfPresent(Timestamp.self, forKey: .snoozedUntil)
        snoozedAt = try c.decodeIfPresent(Timestamp.self, forKey: .snoozedAt)
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
}

/// `GET /api/sessions/live` — the whole inbox in one call.
struct LiveSessions: Decodable {
    var sessions: [Session]
    var projects: [ProjectRef]

    private enum CodingKeys: String, CodingKey { case sessions, projects }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessions = try c.decode([Skippable<Session>].self, forKey: .sessions).compactMap(\.value)
        projects = try c.decode([Skippable<ProjectRef>].self, forKey: .projects).compactMap(\.value)
    }
}
