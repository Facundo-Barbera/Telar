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

/// WHAT ONE TURN COST THE MODEL — the provider's own count, summed over the
/// turn's laps by the Mac. A turn that calls three tools goes back to the model
/// four times; the question a person asks is what the TURN cost.
struct AgentUsage: Decodable, Equatable {
    var input: Int
    var output: Int
    var total: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        input = (try? c.decode(Int.self, forKey: .input)) ?? 0
        output = (try? c.decode(Int.self, forKey: .output)) ?? 0
        total = (try? c.decode(Int.self, forKey: .total)) ?? (input + output)
    }

    private enum CodingKeys: String, CodingKey { case input, output, total }

    init(input: Int, output: Int, total: Int) {
        self.input = input
        self.output = output
        self.total = total
    }
}

/// THE CONTEXT METER — what the last completed turn cost, and how full the
/// prompt that produced it was (#539).
///
/// TWO NUMBERS OF DIFFERENT KINDS. `usage` is a PRICE, from the provider. The
/// characters are a LEVEL, measured by the Mac's own trim step against the
/// ceiling that will actually drop the oldest exchange — so the percentage is of
/// Telar's budget rather than of the model's window, because Telar's is the one
/// that bites first.
struct AgentLastUsage: Decodable, Equatable {
    var runId: String
    var at: Timestamp?
    /// ABSENT WHEN THE MODEL REPORTED NONE, which is a real case: an
    /// OpenAI-compatible server need not send usage, and a zero here would read
    /// as "that turn was free" rather than "nobody said".
    var usage: AgentUsage?
    var contextChars: Int
    var budgetChars: Int

    private enum CodingKeys: String, CodingKey { case runId, at, usage, contextChars, budgetChars }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runId = (try? c.decode(String.self, forKey: .runId)) ?? ""
        at = try? c.decodeIfPresent(Timestamp.self, forKey: .at)
        usage = try? c.decodeIfPresent(AgentUsage.self, forKey: .usage)
        contextChars = (try? c.decode(Int.self, forKey: .contextChars)) ?? 0
        budgetChars = (try? c.decode(Int.self, forKey: .budgetChars)) ?? 0
    }

    init(runId: String, at: Timestamp? = nil, usage: AgentUsage? = nil, contextChars: Int, budgetChars: Int) {
        self.runId = runId
        self.at = at
        self.usage = usage
        self.contextChars = contextChars
        self.budgetChars = budgetChars
    }

    /// 0–100, clamped. A prompt OVER budget reads full rather than overflowing:
    /// the Mac's trim keeps the newest exchange whatever it costs, so above 100%
    /// is a state that really happens and "full" is the honest way to draw it.
    var percent: Int {
        guard budgetChars > 0 else { return 0 }
        return min(100, max(0, Int((Double(contextChars) / Double(budgetChars) * 100).rounded())))
    }

    /// THE LINE UNDER THE HEADER, or `nil` when there is nothing honest to say —
    /// no ceiling to measure against. Tokens are dropped rather than zeroed when
    /// the provider reported none.
    var meterLine: String? {
        guard budgetChars > 0 else { return nil }
        guard let usage else { return "\(percent)% context" }
        return "\(usage.total.formatted(.number.grouping(.automatic))) tokens · \(percent)% context"
    }
}

/// WHAT A MAC'S AGENT IS DOING RIGHT NOW — the stored document plus the things
/// only a running engine knows.
struct AgentState: Decodable, Equatable {
    var enabled: Bool
    var threadId: String?
    var model: String?
    /// `reasoning_effort` on the wire (#539). ABSENT MEANS THE PARAMETER IS NOT
    /// SENT — the provider's own default — which is not the same as a default
    /// value, and is why the composer's pill offers "Auto" rather than a level.
    var effort: String?
    /// Absent means `ask`, which is what shipped: a person answers the approval
    /// gate. `auto` answers it by policy. NEITHER changes which calls are gated.
    var access: String?
    /// A turn is executing. FALSE while one is parked for a person, which is
    /// why `request` sits beside this rather than inside it.
    var running: Bool
    var runId: String?
    var queued: Int
    var request: AgentRequest?
    /// The context meter, from the last turn that ENDED. Absent until one has,
    /// and unchanged while the next runs — a meter that emptied itself the
    /// moment you spoke would answer a question nobody asked.
    var lastUsage: AgentLastUsage?

    private enum CodingKeys: String, CodingKey { case enabled, threadId, model, effort, access, running, runId, queued, request, lastUsage }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? false
        threadId = try? c.decodeIfPresent(String.self, forKey: .threadId)
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        effort = try? c.decodeIfPresent(String.self, forKey: .effort)
        access = try? c.decodeIfPresent(String.self, forKey: .access)
        running = (try? c.decode(Bool.self, forKey: .running)) ?? false
        runId = try? c.decodeIfPresent(String.self, forKey: .runId)
        queued = (try? c.decode(Int.self, forKey: .queued)) ?? 0
        // A REQUEST THIS BUILD CANNOT READ COSTS THE CARD, NEVER THE SCREEN.
        request = try? c.decodeIfPresent(AgentRequest.self, forKey: .request)
        // AND A METER THIS BUILD CANNOT READ COSTS THE LINE. An older Mac sends
        // none at all, which is the same case.
        lastUsage = try? c.decodeIfPresent(AgentLastUsage.self, forKey: .lastUsage)
    }

    init(enabled: Bool, threadId: String? = nil, model: String? = nil, effort: String? = nil, access: String? = nil, running: Bool = false, runId: String? = nil, queued: Int = 0, request: AgentRequest? = nil, lastUsage: AgentLastUsage? = nil) {
        self.enabled = enabled
        self.threadId = threadId
        self.model = model
        self.effort = effort
        self.access = access
        self.running = running
        self.runId = runId
        self.queued = queued
        self.request = request
        self.lastUsage = lastUsage
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
    /// `user_message`, `assistant_message`, and a `turn_done` that failed.
    var text: String?
    /// `assistant_message` — the id the live deltas are keyed by, so a streamed
    /// bubble reconciles with the row that lands instead of drawing beside it.
    /// This phone polls rather than streams, so nothing here uses it yet; it is
    /// decoded because the row carries it and a reader that starts streaming
    /// should not have to change the model to find it.
    var itemId: String?
    /// `user_message` — absent or "user" is a person, anything else is a wake.
    var origin: String?
    var wakeReason: String?
    /// `tool_call`.
    var name: String?
    var output: String?
    var status: String?

    private enum CodingKeys: String, CodingKey { case id, runId, at, kind, detail }
    private enum DetailKeys: String, CodingKey { case text, itemId, origin, wakeReason, name, output, status }

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
        itemId = try? detail?.decodeIfPresent(String.self, forKey: .itemId)
        origin = try? detail?.decodeIfPresent(String.self, forKey: .origin)
        wakeReason = try? detail?.decodeIfPresent(String.self, forKey: .wakeReason)
        name = try? detail?.decodeIfPresent(String.self, forKey: .name)
        output = try? detail?.decodeIfPresent(String.self, forKey: .output)
        status = try? detail?.decodeIfPresent(String.self, forKey: .status)
    }

    init(id: Int, runId: String = "", at: Timestamp = 0, kind: AgentRowKind, text: String? = nil, itemId: String? = nil, origin: String? = nil, wakeReason: String? = nil, name: String? = nil, output: String? = nil, status: String? = nil) {
        self.id = id
        self.runId = runId
        self.at = at
        self.kind = kind
        self.text = text
        self.itemId = itemId
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

/// ONE MODEL THE AGENT MAY RUN, described (#551).
///
/// ── WHY THE ROWS CARRY MORE THAN AN ID NOW ──────────────────────────────────
/// OpenCode Go's `/models` answers `{ id, object, created, owned_by }` and
/// nothing else, so the pill was a flat list of raw strings in Go's own order.
/// The Mac's engine merges models.dev's names and limits into it, plus a
/// transcribed table saying which of Go's three endpoints each id answers on.
/// `route` is the load-bearing one: the Agent speaks `chat/completions` and
/// only that, so a `/messages` or `/responses` model has to be shown as
/// unreachable rather than sold and then refused by a 400.
///
/// ── EVERY NEW FIELD IS OPTIONAL-TOLERANT, ON PURPOSE ────────────────────────
/// This app talks to whatever engine the paired Mac is running, which may be
/// older than this build. A synthesised `Decodable` would make `route` required
/// and drop every row from such a Mac — an empty picker, with no message to say
/// why. So each field falls back: no `name` means the id, no `route` means
/// `unknown`, and an unstated `supported` is `true`, because an engine that
/// never heard of routes was serving a list this client could already run.
struct AgentModel: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var family: String
    /// "chat" | "messages" | "responses" | "unknown". A STRING rather than an
    /// enum: a fourth value invented by a newer engine must not fail the decode
    /// of a row this screen can still list.
    var route: String
    var supported: Bool
    var described: Bool
    var reasoning: Bool?
    var toolCall: Bool?
    var attachment: Bool?
    var context: Int?
    var output: Int?
    var releaseDate: String?
    /// The engine's own default, marked on one row. What "Default" means.
    var isDefault: Bool

    private enum CodingKeys: String, CodingKey {
        case id, name, label, family, route, supported, described, reasoning, toolCall, attachment, context, output, releaseDate, isDefault
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // `decodeIfPresent` under `try?` answers a DOUBLE optional — the outer
        // one is "the decode threw", the inner "the key was absent". `?? nil`
        // flattens both into the same answer, which is what every fallback
        // below wants.
        func text(_ key: CodingKeys) -> String? { (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil }
        func flag(_ key: CodingKeys) -> Bool? { (try? c.decodeIfPresent(Bool.self, forKey: key)) ?? nil }
        func number(_ key: CodingKeys) -> Int? { (try? c.decodeIfPresent(Int.self, forKey: key)) ?? nil }

        // THE ID IS THE ONLY THING WORTH FAILING OVER — it is what goes on the
        // wire, and a row without one cannot be picked.
        id = try c.decode(String.self, forKey: .id)
        // `label` is the older engine's name for the same string.
        name = text(.name) ?? text(.label) ?? id
        family = text(.family) ?? "Models"
        route = text(.route) ?? "unknown"
        supported = flag(.supported) ?? true
        described = flag(.described) ?? false
        reasoning = flag(.reasoning)
        toolCall = flag(.toolCall)
        attachment = flag(.attachment)
        context = number(.context)
        output = number(.output)
        releaseDate = text(.releaseDate)
        isDefault = flag(.isDefault) ?? false
    }

    /// For previews and tests. Every described field defaults to absent, which
    /// is the state a Go-only id is really in.
    init(
        id: String,
        name: String,
        family: String = "Models",
        route: String = "chat",
        supported: Bool = true,
        described: Bool = true,
        context: Int? = nil,
        releaseDate: String? = nil,
        isDefault: Bool = false
    ) {
        self.id = id
        self.name = name
        self.family = family
        self.route = route
        self.supported = supported
        self.described = described
        self.reasoning = nil
        self.toolCall = nil
        self.attachment = nil
        self.context = context
        self.output = nil
        self.releaseDate = releaseDate
        self.isDefault = isDefault
    }
}

/// `GET /api/agent/models` — the composer's model pill (#539, described by #551).
///
/// FAILS SOFT IN TWO INDEPENDENT HALVES, which is why `source` is decoded
/// rather than collapsed into one flag. `go == nil` is a Mac that could not
/// reach OpenCode Go, or has no key yet: an empty list and a `message`.
/// `modelsDev == nil` is a full list of ids nobody described — usable, but the
/// picker should say so rather than let it read as the old raw-id list.
struct AgentModelList: Decodable {
    struct Source: Decodable, Equatable {
        var go: Double?
        var modelsDev: Double?
    }

    var models: [AgentModel]
    var source: Source
    var message: String?

    private enum CodingKeys: String, CodingKey { case models, source, message }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A ROW THIS BUILD CANNOT READ IS DROPPED, never the list.
        models = try c.decodeIfPresent([Skippable<AgentModel>].self, forKey: .models)?.compactMap(\.value) ?? []
        // AN ENGINE TOO OLD TO SEND `source` IS NOT A FAILURE. It served a list
        // it had really read, so the honest reading of a missing stamp is
        // "unknown when", not "both halves are down" — and the only thing this
        // field drives is a footnote.
        source = ((try? c.decodeIfPresent(Source.self, forKey: .source)) ?? nil) ?? Source(go: nil, modelsDev: nil)
        message = try? c.decodeIfPresent(String.self, forKey: .message)
    }

    init(models: [AgentModel], message: String?, source: Source = Source(go: nil, modelsDev: nil)) {
        self.models = models
        self.source = source
        self.message = message
    }
}

/// `PATCH /api/agent` — the three composer pills' write (#539).
///
/// BY PRESENCE, NEVER BY VALUE. A phone setting an effort must not also be
/// re-deciding who answers approvals, so an absent field means "leave it alone"
/// and `""` means "clear it" — the same contract the Mac's own route keeps.
/// That is exactly what an optional encodes to with the default encoder, which
/// is why there is nothing clever here.
struct AgentSettingsPatch: Encodable {
    var model: String?
    /// `"low" | "medium" | "high"`, or `""` to stop sending `reasoning_effort`
    /// at all — the provider's own default.
    var effort: String?
    /// `"ask"` (the default) or `"auto"`. `auto` answers the approval gate by
    /// policy; it does NOT widen which calls are gated.
    var access: String?
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
