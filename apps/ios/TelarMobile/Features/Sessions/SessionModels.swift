import Foundation

enum SessionActivity: String, Codable, Comparable {
    case blocked, working, queued, monitoring, idle

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionActivity(rawValue: raw) ?? .idle
    }

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

struct SessionWorkspace: Codable, Equatable {
    var mode: String
    var path: String?
    var branch: String?
    var baseRef: String?
}

struct SessionProvenance: Codable, Equatable {
    var sessionId: EngineID
    var runId: EngineID?
}

struct SessionSettledBy: Codable, Equatable {
    var kind: String

    var coordinatorSessionId: EngineID

    var runId: EngineID?
    var at: Timestamp?
}

struct SessionAssignment: Codable, Equatable {
    var fromSessionId: EngineID

    var scope: String?
    var outcome: String?

    var unresolved: Bool?

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

struct Subscription: Codable, Equatable, Identifiable {
    var id: EngineID
    var subscriberSessionId: EngineID
    var targetSessionId: EngineID
}

struct Session: Codable, Identifiable, Equatable {
    var id: EngineID

    var projectId: EngineID?
    var title: String
    var state: SessionState
    var createdAt: Timestamp
    var updatedAt: Timestamp

    var driver: String

    var resumeCursor: String? = nil
    var providerInstanceId: String?
    var model: ModelSelection?
    var workspace: SessionWorkspace
    var runtimeMode: String
    var detached: Bool

    var usage: UsageSnapshot?

    var activity: SessionActivity
    var activityAt: Timestamp?
    var lastTurnEndedAt: Timestamp?
    var lastTurnFailed: Bool?

    var lastTurnSequence: Int?
    var lastReadTurnSequence: Int?

    var readAt: Timestamp?

    var settledOverride: String?
    var settledAt: Timestamp?

    var settledBy: SessionSettledBy?
    var snoozedUntil: Timestamp?
    var snoozedAt: Timestamp?

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

        activity = try c.decodeIfPresent(SessionActivity.self, forKey: .activity) ?? .idle
        activityAt = try c.decodeIfPresent(Timestamp.self, forKey: .activityAt)
        lastTurnEndedAt = try c.decodeIfPresent(Timestamp.self, forKey: .lastTurnEndedAt)
        lastTurnFailed = try c.decodeIfPresent(Bool.self, forKey: .lastTurnFailed)
        settledOverride = try c.decodeIfPresent(String.self, forKey: .settledOverride)
        settledAt = try c.decodeIfPresent(Timestamp.self, forKey: .settledAt)

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

    var icon: String?

    var iconName: String?

    var iconEmoji: String?

    var root: String?

    var remoteUrl: String?

    var availability: ProjectAvailability?

    var mark: ProjectMark { ProjectMark(icon: icon, iconName: iconName, iconEmoji: iconEmoji) }
}

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

struct LiveSessions: Decodable {
    var sessions: [Session]
    var projects: [ProjectRef]

    var layout: SidebarLayout?

    var assignments: [EngineID: [SessionAssignment]] = [:]

    var inbox: InboxPolicy?

    var revision: Int?

    var settledCount: Int?

    var unchanged: Bool = false

    private enum CodingKeys: String, CodingKey { case sessions, projects, layout, assignments, inbox, revision, settledCount, unchanged }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)

        inbox = try? c.decodeIfPresent(InboxPolicy.self, forKey: .inbox)
        revision = try? c.decodeIfPresent(Int.self, forKey: .revision)
        settledCount = try? c.decodeIfPresent(Int.self, forKey: .settledCount)
        unchanged = (try? c.decode(Bool.self, forKey: .unchanged)) ?? false
        sessions = try c.decodeIfPresent([Skippable<Session>].self, forKey: .sessions)?.compactMap(\.value) ?? []
        projects = try c.decodeIfPresent([Skippable<ProjectRef>].self, forKey: .projects)?.compactMap(\.value) ?? []

        layout = try? c.decodeIfPresent(SidebarLayout.self, forKey: .layout)

        assignments = (try? c.decodeIfPresent([EngineID: [Skippable<SessionAssignment>]].self, forKey: .assignments))?
            .mapValues { $0.compactMap(\.value) } ?? [:]
    }
}
