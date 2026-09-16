import Foundation

/// THE BUILT-IN AGENT, as this phone reads it (#531).
///
/// NOT UNDER `Session`, and that is the whole shape of this file. The Agent has
/// no id in the sessions namespace, its conversation is a flat row log rather
/// than a journal of turns and items, and a phone that reached it through a
/// session type would be holding a `Session` that `sessionEvents` cannot open.
/// So these are their own small types, and the sidebar's Agent row is the only
/// place the two vocabularies meet.
///
/// EVERY FIELD THIS PHONE DOES NOT UNDERSTAND IS SKIPPED, not fatal — the same
/// tolerance `LiveSessions` gives its optionals. A Mac running a newer engine
/// must not be able to blank this screen by adding a row kind.

/// WHAT AN APPROVAL ASKS, carried whole so a surface need not re-derive which
/// call it is about from the conversation.
struct AgentRequest: Decodable, Equatable, Identifiable {
    var id: EngineID
    var runId: String
    var tool: String
    /// ONE SENTENCE IN THE WORDS A PERSON READS, written where the gate is
    /// (`agent/approval.ts`) and specific to the call. A second copy of "what
    /// does `sessions_stop` mean" on this phone would be the one that goes
    /// stale.
    var reason: String
    var openedAt: Timestamp?

    private enum CodingKeys: String, CodingKey { case id, runId, tool, reason, openedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(EngineID.self, forKey: .id)
        runId = (try? c.decode(String.self, forKey: .runId)) ?? ""
        tool = (try? c.decode(String.self, forKey: .tool)) ?? ""
        reason = (try? c.decode(String.self, forKey: .reason)) ?? ""
        openedAt = try? c.decodeIfPresent(Timestamp.self, forKey: .openedAt)
    }

    init(id: EngineID, runId: String = "", tool: String = "", reason: String = "", openedAt: Timestamp? = nil) {
        self.id = id
        self.runId = runId
        self.tool = tool
        self.reason = reason
        self.openedAt = openedAt
    }
}

/// WHAT A MAC'S AGENT IS DOING RIGHT NOW — the stored document plus the three
/// things only a running engine knows.
struct AgentState: Decodable, Equatable {
    var enabled: Bool
    var threadId: String?
    var model: String?
    /// A turn is executing. FALSE while one is parked for a person, which is
    /// why `request` sits beside this rather than inside it.
    var running: Bool
    var runId: String?
    var queued: Int
    var request: AgentRequest?

    private enum CodingKeys: String, CodingKey { case enabled, threadId, model, running, runId, queued, request }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? false
        threadId = try? c.decodeIfPresent(String.self, forKey: .threadId)
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        running = (try? c.decode(Bool.self, forKey: .running)) ?? false
        runId = try? c.decodeIfPresent(String.self, forKey: .runId)
        queued = (try? c.decode(Int.self, forKey: .queued)) ?? 0
        // A REQUEST THIS BUILD CANNOT READ COSTS THE CARD, NEVER THE SCREEN.
        request = try? c.decodeIfPresent(AgentRequest.self, forKey: .request)
    }

    init(enabled: Bool, threadId: String? = nil, model: String? = nil, running: Bool = false, runId: String? = nil, queued: Int = 0, request: AgentRequest? = nil) {
        self.enabled = enabled
        self.threadId = threadId
        self.model = model
        self.running = running
        self.runId = runId
        self.queued = queued
        self.request = request
    }
}

/// `GET /api/agent`. The credential rides along so a surface decides between a
/// field and a setup sentence from one instant — which RUNG answered, never the
/// key.
struct AgentAnswer: Decodable {
    var agent: AgentState
    var credential: AgentCredential?
}

struct AgentCredential: Decodable, Equatable {
    var source: String?
    var set: Bool?
}

/// WHICH KIND OF THING HAPPENED. A `String` behind a small enum rather than a
/// bare `enum`, because a Mac on a newer engine may write a kind this build has
/// never heard of — and the transcript must skip that row rather than fail to
/// decode the page it arrived in.
enum AgentRowKind: String, Decodable {
    case userMessage = "user_message"
    case assistantMessage = "assistant_message"
    case toolCall = "tool_call"
    case requestOpened = "request_opened"
    case requestResolved = "request_resolved"
    case turnStarted = "turn_started"
    case turnDone = "turn_done"
}

/// ONE ROW OF THE AGENT'S TRANSCRIPT.
///
/// `detail` IS KEPT AS THE DECODED FIELDS THIS PHONE DRAWS rather than as raw
/// JSON: the engine keys it by `kind` and nothing here queries inside it, so
/// pulling out the handful of strings the screen renders is both cheaper and
/// the thing a test can assert against.
struct AgentRow: Decodable, Equatable, Identifiable {
    var id: Int
    var runId: String
    var at: Timestamp
    var kind: AgentRowKind
    /// `user_message`, `assistant_message`, and a completed `turn_done`.
    var text: String?
    /// `user_message` — absent or "user" is a person, anything else is a wake.
    var origin: String?
    var wakeReason: String?
    /// `tool_call`.
    var name: String?
    var output: String?
    var status: String?

    private enum CodingKeys: String, CodingKey { case id, runId, at, kind, detail }
    private enum DetailKeys: String, CodingKey { case text, origin, wakeReason, name, output, status }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        runId = (try? c.decode(String.self, forKey: .runId)) ?? ""
        at = (try? c.decode(Timestamp.self, forKey: .at)) ?? 0
        // AN UNKNOWN KIND THROWS, and `Skippable` above it in the page is what
        // turns that into "this row is not drawn" rather than "this page is
        // lost". A newer Mac must not be able to blank the screen.
        kind = try c.decode(AgentRowKind.self, forKey: .kind)
        let detail = try? c.nestedContainer(keyedBy: DetailKeys.self, forKey: .detail)
        text = try? detail?.decodeIfPresent(String.self, forKey: .text)
        origin = try? detail?.decodeIfPresent(String.self, forKey: .origin)
        wakeReason = try? detail?.decodeIfPresent(String.self, forKey: .wakeReason)
        name = try? detail?.decodeIfPresent(String.self, forKey: .name)
        output = try? detail?.decodeIfPresent(String.self, forKey: .output)
        status = try? detail?.decodeIfPresent(String.self, forKey: .status)
    }

    init(id: Int, runId: String = "", at: Timestamp = 0, kind: AgentRowKind, text: String? = nil, origin: String? = nil, wakeReason: String? = nil, name: String? = nil, output: String? = nil, status: String? = nil) {
        self.id = id
        self.runId = runId
        self.at = at
        self.kind = kind
        self.text = text
        self.origin = origin
        self.wakeReason = wakeReason
        self.name = name
        self.output = output
        self.status = status
    }

    /// A TURN WITH NO HUMAN BEHIND IT MUST SAY SO. The Agent subscribes to the
    /// work it delegates, and a completion on one of those enqueues a turn
    /// whose input is the notice. Drawing that as an ordinary user message
    /// would attribute somebody else's machine to the person reading.
    var wakeLabel: String? {
        guard let origin, origin != "user" else { return nil }
        guard let wakeReason, !wakeReason.isEmpty else { return "Woken by Telar" }
        return "Woken — \(wakeReason)"
    }
}

/// `GET /api/agent/thread`. Bounded by a count AND a byte budget, whichever is
/// reached first — page until `more` is false.
struct AgentThreadPage: Decodable {
    var rows: [AgentRow]
    /// The id to pass as the next `after`. Unmoved when the page was empty.
    var cursor: Int
    var more: Bool
    var threadId: String?

    private enum CodingKeys: String, CodingKey { case rows, cursor, more, threadId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A ROW THIS BUILD CANNOT READ IS DROPPED, not fatal — the same
        // tolerance `LiveSessions` gives its sessions.
        rows = try c.decodeIfPresent([Skippable<AgentRow>].self, forKey: .rows)?.compactMap(\.value) ?? []
        cursor = (try? c.decode(Int.self, forKey: .cursor)) ?? 0
        more = (try? c.decode(Bool.self, forKey: .more)) ?? false
        threadId = try? c.decodeIfPresent(String.self, forKey: .threadId)
    }

    init(rows: [AgentRow], cursor: Int, more: Bool, threadId: String? = nil) {
        self.rows = rows
        self.cursor = cursor
        self.more = more
        self.threadId = threadId
    }
}

/// `POST /api/agent/turns`.
struct AgentTurnAccepted: Decodable {
    var runId: String
    var queued: Int
    var agent: AgentState?
}

/// MERGE ROWS BY ID, not by position.
///
/// A PAGE AND A RE-POLL OVERLAP. This phone follows the thread by asking again
/// from the cursor it holds, and a poll that raced a write can hand back a row
/// it already has. Appending would duplicate it; keying by id cannot.
///
/// SORTED BY ID rather than by `at`, because ids are monotonic within a thread
/// and timestamps are not guaranteed to be — two rows written in the same
/// millisecond would otherwise swap places between polls and make the
/// transcript jitter under the thumb.
func mergeAgentRows(_ held: [AgentRow], _ incoming: [AgentRow]) -> [AgentRow] {
    guard !incoming.isEmpty else { return held }
    var byId: [Int: AgentRow] = [:]
    for row in held { byId[row.id] = row }
    for row in incoming { byId[row.id] = row }
    return byId.values.sorted { $0.id < $1.id }
}
