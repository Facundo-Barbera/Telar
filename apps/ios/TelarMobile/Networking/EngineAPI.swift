import Foundation

/// The cockpit's `/api/**` surface — a mirror of the browser client in
/// `apps/web/lib/engine/client.ts`. The app NEVER talks to the engine daemon
/// directly: it binds loopback with a per-boot token, by design. The Next
/// cockpit holds that token server-side and is what Tailscale reaches.
protocol EngineAPI: Sendable {
    func health() async throws -> EngineHealth
    func liveSessions() async throws -> LiveSessions
    /// THE SAME READ, WIDE — every session, settled ones included (#457).
    ///
    /// The Mac's default answer is the UNSETTLED rows alone: 7 of 291 on the
    /// owner's store, where it used to fold and serialise all 291 every three
    /// seconds for every device attached to it. This is what the settled shelf
    /// asks with, and `LiveSessions.settledCount` on the narrow answer is what
    /// draws the shelf that does the asking.
    ///
    /// DECLARED HERE AND DEFAULTED BELOW, like `liveSessions(since:)`: a
    /// conformer that does not implement it (the test doubles) falls back to
    /// the plain read, which on a Mac too old to filter IS the whole list.
    func liveSessions(all: Bool) async throws -> LiveSessions
    /// THE SAME READ, CONDITIONAL ON AN ETAG (#457) — what the inbox poll uses.
    ///
    /// `liveSessions(since:)` below is this in the body and is still served;
    /// the tag is what the poll sends, because the tag carries the MODE as well
    /// as the revision. A cursor is a number about the Mac's store, so one
    /// earned against the unsettled list and spent against `all` is answered
    /// "unchanged" — and the settled shelf a reader has just opened stays empty
    /// until something else happens over there. A 304 also carries no body at
    /// all, where the cursor's cheapest answer is sixty bytes.
    ///
    /// `live == nil` MEANS NOT MODIFIED: keep what you have. Distinct from a
    /// `LiveSessions` with no rows, which would empty the list.
    ///
    /// AND IT CARRIES THE BYTES (#499), which is what the cache is written from
    /// now. The store used to warm it with a SECOND full read of this same
    /// route immediately after this one — 318 KB on the owner's Mac, for rows
    /// it had just been handed. One read serves the screen and the cache.
    ///
    /// `since` IS THE LEGACY CURSOR, offered here so that path returns bytes
    /// too. It is mutually exclusive with `etag` in every caller: only the
    /// NARROW read may use a cursor, for the reason above.
    ///
    /// DECLARED HERE AND DEFAULTED BELOW: a conformer that does not implement
    /// it (the test doubles) falls back to an unconditional read, which is also
    /// what a Mac too old to mint a tag leaves this phone with.
    func liveSessions(matching etag: String?, since: Int?, all: Bool) async throws -> LiveSessionsRead
    /// THE SAME READ, CONDITIONALLY (#459) — what the inbox poll should use.
    ///
    /// Hand back the `revision` from last time and a Mac with nothing new
    /// answers `unchanged` in about sixty bytes, instead of every row this
    /// phone is already drawing. It was 318 KB a read on the owner's store, and
    /// this phone asks every three seconds while anything is live.
    ///
    /// DECLARED HERE AND DEFAULTED BELOW, like `usageReport`: a conformer that
    /// does not implement it (the test doubles) falls back to the full read,
    /// and the real client's override still dispatches dynamically because the
    /// requirement is on the protocol rather than only in the extension.
    func liveSessions(since: Int) async throws -> LiveSessions
    func session(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionSnapshot
    /// THE SAME READ, KEEPING THE BYTES (#499) — what the phone records for
    /// when the Mac is away (SnapshotCache). The wire types decode only, so the
    /// durable form is the cockpit's own JSON.
    ///
    /// ONE READ, NOT TWO. The sync engine used to hydrate a WINDOWED snapshot
    /// for the screen and then fetch the same session UNWINDOWED — the whole
    /// run, up to 4.5 MB — purely to warm that cache. The window the screen
    /// asked for is the window the cache keeps, and it is the same answer, so
    /// the second read is gone rather than merely shrunk.
    ///
    /// DECLARED HERE AND DEFAULTED BELOW: a conformer that does not implement
    /// it makes the plain read and reports no bytes, which simply leaves it
    /// with nothing to record.
    func sessionRead(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionRead
    func events(_ id: EngineID, after: Int) async throws -> EventPage
    /// The bytes behind `ProjectRef.icon`. `icon` rides as `?v=` so the
    /// cockpit's immutable cache header is honest; the route does not read it.
    func projectIcon(_ projectId: EngineID, icon: String) async throws -> Data
    func submitTurn(_ id: EngineID, runId: String, input: String, attachments: [EngineID]?) async throws -> TurnSubmissionResult
    func stopSession(_ id: EngineID) async throws
    func stopTurn(_ id: EngineID, runId: String) async throws
    func resolveRequest(
        _ id: EngineID, requestId: EngineID,
        decision: RequestDecision, reason: String?, answers: [String: AnswerValue]?
    ) async throws
    func patchSession(_ id: EngineID, patch: SessionPatch) async throws
    /// REMOVE A SESSION AND EVERYTHING IT OWNS — transcript included. No undo,
    /// and the engine refuses while a turn is in flight (`EngineStore
    /// .deleteSession` throws a conflict on a queued, claimed or running one),
    /// which is why the row that calls this is disabled there rather than
    /// offered and then rejected.
    func deleteSession(_ id: EngineID) async throws
    /// A HUMAN WAS SHOWN THIS TURN'S ANSWER. Moves the engine's
    /// `lastReadTurnSequence` forward and stamps `readAt`, which is what clears
    /// the unread dot on every device — the phone used to send this NEVER, so a
    /// session read on the phone stayed unread on the Mac, and once the
    /// settling rule started honouring unread it would have stayed in the list
    /// forever. Returns the session as the engine now has it.
    func markSessionRead(_ id: EngineID, runId: String) async throws -> Session
    /// SEND NOW: a queued turn is promoted into the RUNNING turn — the model
    /// hears it without stopping. The engine validates queued-into-running.
    func promoteTurn(_ id: EngineID, runId: String) async throws
    func createSession(projectId: EngineID, input: NewSessionInput) async throws -> Session
    /// The auto-settle window — engine-scoped, one answer per machine, so the
    /// phone bands its inbox the same way the Mac's sidebar does.
    func inboxPolicy() async throws -> InboxPolicy
    /// The rail's arrangement — engine-scoped like the policy above.
    ///
    /// THE FALLBACK, NOT THE PATH. The layout rides `liveSessions()`, so a Mac
    /// new enough to send it is never asked for this; it is here for one that
    /// is not, where a rail with no arrangement at all would be the regression.
    func sidebarLayout() async throws -> SidebarLayout
    /// WHO THIS SESSION HAS ASKED TO BE WOKEN BY. Read for the PINNED handful
    /// only and never per row of the list: pinned is what a person keeps in
    /// view, so this stays a bounded read rather than an N+1 over the inbox.
    func sessionSubscriptions(_ id: EngineID) async throws -> [Subscription]
    /// One file's bytes, uploaded BEFORE the message that refers to it.
    func uploadAttachment(_ id: EngineID, name: String, mediaType: String, data: Data) async throws -> TurnAttachment
    /// The provider's own model list for a driver.
    func models(driver: String) async throws -> ModelCatalogue
    /// Provider instances — a model change must name the instance that runs it.
    func providerInstances() async throws -> [ProviderInstance]
    /// What the session has done to the repository since it started.
    func sessionDiff(_ id: EngineID) async throws -> SessionDiff
    /// One file's patch, opened on demand.
    func filePatch(_ id: EngineID, path: String, untracked: Bool) async throws -> FilePatch
    /// Directories on the Mac — the phone's folder picker.
    func listDirectories(path: String?) async throws -> DirectoryListing
    func registerProject(name: String, root: String) async throws -> ProjectRef
    /// Branches for the draft's base-ref picker.
    func projectGit(_ projectId: EngineID) async throws -> GitOverview
    /// The cockpit's paired-device panel — who may reach the Mac, from here.
    /// Spend over time, folded from THIS Mac's provider transcripts — see
    /// `UsageReport`. The window rides through verbatim; the engine owns the
    /// validation, and re-checking it here would be a second copy of the rule.
    func usageReport(sinceMs: Timestamp, untilMs: Timestamp, resolution: String, timeZone: String) async throws -> UsageReport

    func remoteStatus() async throws -> RemoteStatus
    func renameDevice(_ id: String, name: String) async throws -> RemoteDevice
    func setDeviceRole(_ id: String, role: String) async throws -> RemoteDevice
    func revokeDevice(_ id: String) async throws
    /// Revoke every device except this one (the server keeps the caller).
    func revokeOtherDevices() async throws -> Int
}

/// Mirror of `SnapshotWindow` in packages/engine-client: how much of a
/// session to read. Nil = the whole thing.
struct SnapshotWindow: Sendable {
    /// Newest N settled turns (unsettled ones always ride along).
    var turns: Int
    /// Page cursor from a previous read's `page.before`.
    var before: EngineID?

    init(turns: Int, before: EngineID? = nil) {
        self.turns = turns
        self.before = before
    }
}

/// ONE LIVE-LIST READ, SERVING BOTH THE SCREEN AND THE CACHE (#499).
///
/// The store used to poll this route and then immediately read it again,
/// whole, to warm the phone's copy. `data` is why it no longer does: the
/// cockpit's own bytes, kept exactly as they arrived, so the durable form
/// stays the protocol's rather than a second encoding of it.
struct LiveSessionsRead: Sendable {
    /// NIL MEANS NOT MODIFIED — keep what you have. Never "there is nothing".
    var live: LiveSessions?
    /// What to send back as `If-None-Match` next time. Restated by the Mac on
    /// a 304, so a caller that dropped it there would pay for a full read.
    var etag: String?
    /// The body as the Mac sent it. Nil on a 304 (there is no body) and from a
    /// conformer that cannot hand its bytes over — both mean "nothing new to
    /// record", never "record emptiness".
    var data: Data?
}

/// The same bargain for one session's snapshot (#499): the window the screen
/// asked for, and the bytes to record it with.
struct SessionRead: Sendable {
    var snapshot: SessionSnapshot
    /// Nil from a conformer that cannot hand its bytes over; the cache then
    /// keeps whatever it last held.
    var data: Data?
}

extension EngineAPI {
    /// The unwindowed read older call sites mean.
    func session(_ id: EngineID) async throws -> SessionSnapshot {
        try await session(id, window: nil)
    }

    /// A double that models the transcript and not the rail answers "nobody has
    /// arranged anything", which is a real arrangement and not an error.
    func sidebarLayout() async throws -> SidebarLayout { SidebarLayout() }

    /// A double that models no registry has nothing to remove, and says so by
    /// returning rather than throwing: a test standing in for one endpoint
    /// should not have to implement every other one to compile.
    func deleteSession(_ id: EngineID) async throws {}

    /// And "this session follows nobody", which is the ordinary answer rather
    /// than an error — a cockpit too old to serve the route says the same.
    func sessionSubscriptions(_ id: EngineID) async throws -> [Subscription] { [] }

    /// A double that models the transcript has no ledger to read, and says so
    /// with an empty window rather than by throwing.
    func usageReport(sinceMs: Timestamp, untilMs: Timestamp, resolution: String, timeZone: String) async throws -> UsageReport {
        UsageReport.empty
    }

    /// And a conformer that has not learned the conditional read just makes the
    /// full one — which is what a Mac too old to count would force anyway.
    func liveSessions(since: Int) async throws -> LiveSessions {
        try await liveSessions()
    }

    /// Likewise the WIDE read (#457): a conformer that has not learned to ask
    /// for the settled rows makes the plain read, which against a Mac too old
    /// to hold any back is already every row there is.
    func liveSessions(all: Bool) async throws -> LiveSessions {
        try await liveSessions()
    }

    /// And likewise the conditional one: a conformer that cannot send a tag
    /// makes the unconditional read and reports no tag, so the caller never
    /// has one to hand back and every read stays a full one. No bytes either,
    /// which leaves it with nothing to record — the right answer, since the
    /// alternative is recording a snapshot nobody can vouch for.
    func liveSessions(matching etag: String?, since: Int?, all: Bool) async throws -> LiveSessionsRead {
        if let since { return LiveSessionsRead(live: try await liveSessions(since: since), etag: nil, data: nil) }
        return LiveSessionsRead(live: try await liveSessions(all: all), etag: nil, data: nil)
    }

    /// And the session snapshot: a conformer that cannot hand its bytes over
    /// still answers the screen, and simply records nothing.
    func sessionRead(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionRead {
        SessionRead(snapshot: try await session(id, window: window), data: nil)
    }
}

/// A raw read that keeps the content type: the PDF viewer and the image
/// viewer need to know what the bytes are, and the route says so.
struct RawFile: Sendable {
    var data: Data
    var contentType: String?
}

/// THE PANEL'S API — the checkout, the kernel, notebooks and LaTeX. A second
/// protocol rather than more methods on `EngineAPI`, so the two test doubles
/// that stand in for the transcript's needs keep compiling, and so a view
/// that only reads files can say so in its type.
///
/// `ds` and `latex` are catch-all doors: every verb is a POST to one path,
/// the same door the agent's own tools use, so a cell run from here and one
/// the model ran land in the same kernel. Their answers decode to the caller's
/// type; a body this build does not model decodes to `JSONValue`, never to
/// the "very different versions" error a snapshot mismatch earns.
protocol PanelAPI: Sendable {
    func projects() async throws -> [Project]
    func sessionFiles(_ id: EngineID) async throws -> WorkspaceListing
    func sessionFile(_ id: EngineID, path: String) async throws -> WorkspaceFile
    func writeSessionFile(_ id: EngineID, path: String, text: String, expectedSha256: String) async throws -> WorkspaceWriteResult
    func sessionFileRaw(_ id: EngineID, path: String) async throws -> RawFile
    func sessionTable(_ id: EngineID, path: String, offset: Int, limit: Int, sort: String?, desc: Bool) async throws -> TableWindow
    func attachments(_ id: EngineID, tag: String?) async throws -> [TurnAttachment]
    func attachmentBytes(_ id: EngineID, attachmentId: EngineID) async throws -> RawFile
    func tagAttachment(_ id: EngineID, attachmentId: EngineID, tags: [String]) async throws -> TurnAttachment
    func ds<T: Decodable & Sendable>(_ id: EngineID, method: String, body: JSONValue) async throws -> T
    func latex<T: Decodable & Sendable>(_ id: EngineID, method: String, body: JSONValue) async throws -> T
}

extension PanelAPI {
    func kernel(_ id: EngineID) async throws -> KernelStatus { try await ds(id, method: "kernel", body: .object([:])) }
    func kernelInterrupt(_ id: EngineID) async throws { let _: JSONValue = try await ds(id, method: "interrupt", body: .object([:])) }
    func kernelRestart(_ id: EngineID) async throws { let _: JSONValue = try await ds(id, method: "restart", body: .object([:])) }
    func kernelVars(_ id: EngineID, limit: Int = 200) async throws -> [VarRow] {
        try await ds(id, method: "vars", body: .object(["limit": .number(Double(limit))]))
    }
    func kernelInspect(_ id: EngineID, name: String, depth: Int = 10) async throws -> JSONValue {
        try await ds(id, method: "inspect", body: .object(["name": .string(name), "depth": .number(Double(depth))]))
    }
    func packages(_ id: EngineID) async throws -> PackageList { try await ds(id, method: "packages", body: .object([:])) }
    func notebookRead(_ id: EngineID, path: String, withOutputs: Bool = true) async throws -> NotebookRead {
        try await ds(id, method: "notebook/read", body: .object(["path": .string(path), "withOutputs": .bool(withOutputs)]))
    }
    func notebookEdit(_ id: EngineID, path: String, edit: JSONValue) async throws -> NotebookRead {
        try await ds(id, method: "notebook/edit", body: .object(["path": .string(path), "edit": edit]))
    }
    func notebookRun(_ id: EngineID, path: String, cellId: String?, all: Bool = false) async throws -> NotebookRunResult {
        var body: [String: JSONValue] = ["path": .string(path)]
        if let cellId { body["cellId"] = .string(cellId) }
        if all { body["all"] = .bool(true) }
        return try await ds(id, method: "notebook/run", body: .object(body))
    }
    func latexStatus(_ id: EngineID) async throws -> LatexCompileStatus { try await latex(id, method: "status", body: .object([:])) }
    func latexCompile(_ id: EngineID, path: String?) async throws -> LatexCompileAnswer {
        try await latex(id, method: "compile", body: .object(path.map { ["path": .string($0)] } ?? [:]))
    }
    func latexLog(_ id: EngineID, tail: Int = 200) async throws -> LatexLog {
        try await latex(id, method: "log", body: .object(["tail": .number(Double(tail))]))
    }
    func latexToolchain(_ id: EngineID) async throws -> LatexToolchain { try await latex(id, method: "toolchain", body: .object([:])) }
}

struct InboxPolicy: Decodable, Equatable {
    /// `nil` = the clock is off: nothing settles by neglect, only by decision.
    var autoSettleAfterHours: Double?
}

/// Mirror of `createSession`'s input in apps/web/lib/engine/client.ts. The
/// engine validates driver/envMode against the contract's own lists.
struct NewSessionInput: Encodable {
    var title: String?
    var driver: String?
    var envMode: String?
    /// Worktree base — any name from `GitOverview.refs`. Absent = HEAD.
    var baseRef: String?
    /// The worktree's own branch name. Absent = the engine invents one.
    var branchName: String?
}

/// The shapes a `user_input` answer takes (`UserInputField.kind`
/// text/secret/choice all answer with a string; boolean with a bool; a
/// `choice` field marked `multiple` with an array of the chosen labels).
enum AnswerValue: Encodable, Equatable {
    case text(String)
    case bool(Bool)
    case list([String])

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .text(let s): try c.encode(s)
        case .bool(let b): try c.encode(b)
        case .list(let labels): try c.encode(labels)
        }
    }
}

struct SessionPatch: Encodable {
    var title: String?
    var settledOverride: String?
    var snoozedUntil: Timestamp?
    /// "approval-required" | "auto-accept-edits" | "auto" | "full-access" —
    /// engine-validated; the composer's Configuration pill.
    var runtimeMode: String?
    /// Must belong to the session's provider instance — the engine rejects
    /// anything else. The composer's Model pill.
    var model: ModelSelection?
    var clearSettledOverride = false
    var clearSnooze = false
    private enum CodingKeys: String, CodingKey { case title, settledOverride, snoozedUntil, runtimeMode, model }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(title, forKey: .title)
        if clearSettledOverride { try c.encodeNil(forKey: .settledOverride) }
        else { try c.encodeIfPresent(settledOverride, forKey: .settledOverride) }
        if clearSnooze { try c.encodeNil(forKey: .snoozedUntil) }
        else { try c.encodeIfPresent(snoozedUntil, forKey: .snoozedUntil) }
        try c.encodeIfPresent(runtimeMode, forKey: .runtimeMode)
        try c.encodeIfPresent(model, forKey: .model)
    }
}

enum EngineAPIError: Error, LocalizedError {
    /// The cockpit answered with a typed engine error.
    case engine(code: String, message: String, status: Int)
    /// The cockpit answered, but not with the contract's error body.
    case badResponse(status: Int)
    /// A 2xx whose body didn't decode: the URL IS a cockpit — the two ends
    /// are just on very different versions. Distinct from badResponse so
    /// skew is never misdiagnosed as a wrong address.
    case incompatible(status: Int)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .engine(let code, let message, _):
            switch code {
            case "cockpit_unauthorized": "This phone is not paired with the cockpit — get a pairing code from Settings → Remote access."
            case "cockpit_forbidden": "This phone is paired for viewing only — give it full access from Remote access on the Mac."
            case "engine_unavailable": "The Mac's engine is down — the cockpit is up but can't reach it."
            case "worker_unavailable": "No worker is running on the Mac to take the turn."
            case "not_found": "That no longer exists on the engine."
            default: message
            }
        case .badResponse(let status): "Unexpected response (\(status)) — is the base URL a Telar cockpit?"
        case .incompatible: "The Mac and this app are on very different versions — update whichever is older."
        case .transport(let error): error.localizedDescription
        }
    }

    var isNotFound: Bool {
        if case .engine(let code, _, _) = self { return code == "not_found" }
        return false
    }

    /// The cockpit's pairing gate said no — this phone holds no valid device
    /// token. The fix is a fresh pairing code, not a retry.
    var isUnauthorized: Bool {
        if case .engine(let code, _, _) = self { return code == "cockpit_unauthorized" }
        return false
    }

    /// Paired, but view-only: the gate admits reads and refuses writes.
    var isForbidden: Bool {
        if case .engine(let code, _, _) = self { return code == "cockpit_forbidden" }
        return false
    }
}

/// Idempotency keys, mirroring `newRunId` in apps/web/lib/engine/client.ts:
/// `run_` + uuid without dashes. The SAME id retried is what makes a resend
/// after a dropped response safe.
enum RunID {
    static func newRunId() -> String {
        "run_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}

struct HTTPEngineAPI: EngineAPI {
    let baseURL: URL
    /// The pairing credential, attached to every request when present. Lives
    /// in the Keychain (KeychainStore); nil against an open cockpit.
    let deviceToken: String?
    let session: URLSession

    init(baseURL: URL, deviceToken: String? = nil, session: URLSession? = nil) {
        self.baseURL = baseURL
        self.deviceToken = deviceToken
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            // 30, not 15: creating a worktree session checks out the whole
            // repo, and a big one blows a 15s window — the create "fails" on
            // the phone while succeeding on the Mac.
            config.timeoutIntervalForRequest = 30
            // Fail fast when off the tailnet instead of queueing silently.
            config.waitsForConnectivity = false
            self.session = URLSession(configuration: config)
        }
    }

    func sidebarLayout() async throws -> SidebarLayout {
        struct Reply: Decodable { var layout: SidebarLayout }
        let reply: Reply = try await get("api/sidebar-layout")
        return reply.layout
    }

    /// ONE FIELD PER WRITE, and the engine leaves an absent one alone.
    ///
    /// The phone used to send the whole `projectOrder` it happened to be
    /// holding, which meant a drop here silently republished a minute-old copy
    /// of the OTHER two arrangements' neighbour — and, once the Mac grew row
    /// order (#301), any reorder made there in between. Naming only the field
    /// that moved is what makes last-write-wins mean "the field you dragged"
    /// rather than "the document you loaded".
    ///
    /// Returns the layout as the engine now holds it, so the caller applies the
    /// Mac's answer rather than its own guess at it.
    func setSidebarLayout(
        projectOrder: [String]? = nil,
        sessionOrder: [String: [String]]? = nil,
        pinnedOrder: [String]? = nil
    ) async throws -> SidebarLayout {
        struct Reply: Decodable { var layout: SidebarLayout }
        var patch: [String: JSONValue] = [:]
        if let projectOrder { patch["projectOrder"] = .array(projectOrder.map { .string($0) }) }
        if let sessionOrder {
            patch["sessionOrder"] = .object(sessionOrder.mapValues { .array($0.map { .string($0) }) })
        }
        if let pinnedOrder { patch["pinnedOrder"] = .array(pinnedOrder.map { .string($0) }) }
        let reply: Reply = try await send("PATCH", "api/sidebar-layout", body: JSONValue.object(patch))
        return reply.layout
    }

    func sessionSubscriptions(_ id: EngineID) async throws -> [Subscription] {
        struct Reply: Decodable { var subscriptions: [Skippable<Subscription>] }
        let reply: Reply = try await get("api/sessions/\(escape(id))/subscriptions")
        return reply.subscriptions.compactMap(\.value)
    }

    func registerPush(_ registration: PushRegistration) async throws -> PushStatus {
        try await send("PUT", "api/mobile/push", body: registration)
    }

    func pushStatus() async throws -> PushStatus { try await get("api/mobile/push") }

    func health() async throws -> EngineHealth {
        try await get("api/health")
    }

    /// THE UNSETTLED ROWS (#457) — 7 of 291 on the owner's store, where this
    /// route used to fold and serialise all 291 every three seconds for every
    /// device attached to the Mac. `LiveSessions.settledCount` says how many it
    /// held back, which is what draws the shelf that asks for them.
    func liveSessions() async throws -> LiveSessions {
        try await get("api/sessions/live")
    }

    /// And every row, settled ones included — what the settled shelf asks with.
    ///
    /// SPELLED AS ITS OWN METHOD rather than a defaulted argument on the one
    /// above: a default argument does not witness a protocol requirement that
    /// takes no argument, and both spellings are requirements here.
    func liveSessions(all: Bool) async throws -> LiveSessions {
        try await get("api/sessions/live", query: all ? [URLQueryItem(name: "all", value: "1")] : [])
    }

    /// THE SAME LIST, CONDITIONALLY — and always the NARROW one. `all` is
    /// deliberately not offered here: the revision counts writes, so it does not
    /// move when a reader opens the shelf, and a cursor earned against one list
    /// and spent against the other would be answered "unchanged" and leave the
    /// shelf empty. The wide ask pays for itself; see the engine's route.
    func liveSessions(since: Int) async throws -> LiveSessions {
        try await get("api/sessions/live", query: [URLQueryItem(name: "since", value: String(since))])
    }

    /// THE POLL'S READ (#457): conditional on an `ETag`, which — unlike the
    /// cursor above — carries the MODE, so it is safe for the wide list too.
    ///
    /// A 304 IS NOT AN ERROR, and that is why this does not go through
    /// `perform`: that envelope treats anything outside 2xx as a failure and
    /// decodes a body, and the cheapest answer here has neither a 2xx nor a
    /// body. `nil` back means "keep what you have" — never "there is nothing".
    ///
    /// THE TAG COMES BACK EVEN ON A 304, because the Mac restates it, and a
    /// caller that dropped it there would make the next tick a full read.
    ///
    /// AND THE BYTES COME BACK WITH IT (#499). They are already in hand here;
    /// handing them over is what let the store stop re-reading this whole route
    /// a second time just to warm its cache.
    ///
    /// `since` IS THE LEGACY CURSOR, carried so that path keeps its bytes too.
    /// Callers send one or the other, never both — a cursor is a number about
    /// the Mac's store and cannot be spent on the wide list.
    func liveSessions(matching etag: String?, since: Int?, all: Bool) async throws -> LiveSessionsRead {
        var query: [URLQueryItem] = []
        if all { query.append(URLQueryItem(name: "all", value: "1")) }
        if let since { query.append(URLQueryItem(name: "since", value: String(since))) }
        var request = makeRequest(url("api/sessions/live", query: query))
        if let etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        // The URL cache stays out of this: the tag bookkeeping is the store's
        // own, and a cache revalidating underneath it would answer from a copy
        // this code never saw.
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw EngineAPIError.transport(error)
        }
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        let fresh = http?.value(forHTTPHeaderField: "Etag")
        if status == 304 { return LiveSessionsRead(live: nil, etag: fresh ?? etag, data: nil) }
        guard (200..<300).contains(status) else {
            if let body = try? JSONDecoder().decode(EngineErrorBody.self, from: data) {
                throw EngineAPIError.engine(code: body.error.code, message: body.error.message, status: status)
            }
            throw EngineAPIError.badResponse(status: status)
        }
        // A 2xx that does not decode is version skew, not a wrong address —
        // `incompatible`, exactly as `perform` classifies it.
        guard let live = try? JSONDecoder().decode(LiveSessions.self, from: data) else {
            throw EngineAPIError.incompatible(status: status)
        }
        // NOT THE BYTES OF AN `unchanged` ANSWER. The cursor's cheap reply is a
        // 200 carrying no rows, and recording it would replace the phone's copy
        // with emptiness — the one thing the cache exists not to show.
        return LiveSessionsRead(live: live, etag: fresh, data: live.unchanged ? nil : data)
    }

    func session(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionSnapshot {
        try await get("api/sessions/\(escape(id))", query: sessionQuery(window))
    }

    /// THE SAME READ, KEEPING THE BYTES (#499) — one request that answers the
    /// screen and records the phone's copy.
    ///
    /// The window is whatever the caller asked for, so the cache holds exactly
    /// what the transcript opened on. It used to hold the UNWINDOWED run — a
    /// separate GET of up to 4.5 MB, fired straight after a hydrate that had
    /// deliberately asked for ten turns.
    func sessionRead(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionRead {
        let (data, status) = try await raw(makeRequest(url("api/sessions/\(escape(id))", query: sessionQuery(window))))
        // Decoded off the caller's executor, exactly as `perform` does it: every
        // caller here is `@MainActor`, and a session's tool outputs are the
        // largest parse this app makes.
        let snapshot: SessionSnapshot = try await Task.detached(priority: .userInitiated) {
            do {
                return try JSONDecoder().decode(SessionSnapshot.self, from: data)
            } catch {
                throw EngineAPIError.incompatible(status: status)
            }
        }.value
        return SessionRead(snapshot: snapshot, data: data)
    }

    private func sessionQuery(_ window: SnapshotWindow?) -> [URLQueryItem] {
        guard let window else { return [] }
        var query = [URLQueryItem(name: "turns", value: String(window.turns))]
        if let before = window.before {
            query.append(URLQueryItem(name: "before", value: before))
        }
        return query
    }

    func events(_ id: EngineID, after: Int) async throws -> EventPage {
        try await get("api/sessions/\(escape(id))/events", query: [URLQueryItem(name: "after", value: String(after))])
    }

    func projectIcon(_ projectId: EngineID, icon: String) async throws -> Data {
        try await raw(makeRequest(url("api/projects/\(escape(projectId))/icon", query: [URLQueryItem(name: "v", value: icon)])))
    }

    func submitTurn(_ id: EngineID, runId: String, input: String, attachments: [EngineID]? = nil) async throws -> TurnSubmissionResult {
        // 202 fresh and 200 replayed are BOTH success — the idempotent retry.
        var body: [String: AnyEncodable] = ["runId": AnyEncodable(runId), "input": AnyEncodable(input)]
        if let attachments, !attachments.isEmpty { body["attachments"] = AnyEncodable(attachments) }
        return try await post("api/sessions/\(escape(id))/turns", body: body)
    }

    func stopTurn(_ id: EngineID, runId: String) async throws {
        let body = ["runId": AnyEncodable(runId)]
        let _: IgnoredBody = try await post("api/sessions/\(escape(id))/stop", body: body)
    }

    func stopSession(_ id: EngineID) async throws {
        let body = ["scope": AnyEncodable("session"), "commandId": AnyEncodable(UUID().uuidString)]
        let _: IgnoredBody = try await post("api/sessions/\(escape(id))/stop", body: body)
    }

    func resolveRequest(
        _ id: EngineID, requestId: EngineID,
        decision: RequestDecision, reason: String?, answers: [String: AnswerValue]?
    ) async throws {
        var body: [String: AnyEncodable] = ["decision": AnyEncodable(decision.rawValue)]
        if let reason { body["reason"] = AnyEncodable(reason) }
        if let answers { body["answers"] = AnyEncodable(answers) }
        let _: IgnoredBody = try await post("api/sessions/\(escape(id))/requests/\(escape(requestId))", body: body)
    }

    func patchSession(_ id: EngineID, patch: SessionPatch) async throws {
        let _: IgnoredBody = try await send("PATCH", "api/sessions/\(escape(id))", body: patch)
    }

    func deleteSession(_ id: EngineID) async throws {
        var request = makeRequest(url("api/sessions/\(escape(id))"))
        request.httpMethod = "DELETE"
        let _: IgnoredBody = try await perform(request)
    }

    func promoteTurn(_ id: EngineID, runId: String) async throws {
        let _: IgnoredBody = try await post("api/sessions/\(escape(id))/turns/\(escape(runId))/promote", body: [:])
    }

    func markSessionRead(_ id: EngineID, runId: String) async throws -> Session {
        struct Wrapped: Decodable { var session: Session }
        let wrapped: Wrapped = try await post("api/sessions/\(escape(id))/read", body: ["runId": AnyEncodable(runId)])
        return wrapped.session
    }

    func createSession(projectId: EngineID, input: NewSessionInput) async throws -> Session {
        struct Created: Decodable { var session: Session }
        let created: Created = try await send("POST", "api/projects/\(escape(projectId))/sessions", body: input)
        return created.session
    }

    func inboxPolicy() async throws -> InboxPolicy {
        struct Wrapped: Decodable { var inbox: InboxPolicy }
        let wrapped: Wrapped = try await get("api/inbox")
        return wrapped.inbox
    }

    /// Raw bytes, one file per request — a failed upload loses one file, not
    /// the whole selection. The filename travels percent-encoded in a header.
    func uploadAttachment(_ id: EngineID, name: String, mediaType: String, data: Data) async throws -> TurnAttachment {
        var request = makeRequest(url("api/sessions/\(escape(id))/attachments"))
        request.httpMethod = "POST"
        request.setValue(mediaType, forHTTPHeaderField: "content-type")
        request.setValue(
            name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "attachment",
            forHTTPHeaderField: "x-telar-attachment-name"
        )
        request.httpBody = data
        struct Wrapped: Decodable { var attachment: TurnAttachment }
        let wrapped: Wrapped = try await perform(request)
        return wrapped.attachment
    }

    func models(driver: String) async throws -> ModelCatalogue {
        struct Wrapped: Decodable { var catalogue: ModelCatalogue }
        let wrapped: Wrapped = try await get("api/models", query: [URLQueryItem(name: "driver", value: driver)])
        return wrapped.catalogue
    }

    func providerInstances() async throws -> [ProviderInstance] {
        struct Wrapped: Decodable { var providerInstances: [ProviderInstance] }
        let wrapped: Wrapped = try await get("api/provider-instances")
        return wrapped.providerInstances
    }

    func sessionDiff(_ id: EngineID) async throws -> SessionDiff {
        struct Wrapped: Decodable { var diff: SessionDiff }
        let wrapped: Wrapped = try await get("api/sessions/\(escape(id))/diff")
        return wrapped.diff
    }

    func filePatch(_ id: EngineID, path: String, untracked: Bool) async throws -> FilePatch {
        var query = [URLQueryItem(name: "path", value: path)]
        if untracked { query.append(URLQueryItem(name: "untracked", value: "1")) }
        struct Wrapped: Decodable { var file: FilePatch }
        let wrapped: Wrapped = try await get("api/sessions/\(escape(id))/diff", query: query)
        return wrapped.file
    }

    func listDirectories(path: String?) async throws -> DirectoryListing {
        var query: [URLQueryItem] = []
        if let path { query.append(URLQueryItem(name: "path", value: path)) }
        return try await get("api/fs", query: query)
    }

    func registerProject(name: String, root: String) async throws -> ProjectRef {
        struct Wrapped: Decodable { var project: ProjectRef }
        let wrapped: Wrapped = try await send("POST", "api/projects", body: ["name": AnyEncodable(name), "root": AnyEncodable(root)])
        return wrapped.project
    }

    func projectGit(_ projectId: EngineID) async throws -> GitOverview {
        struct Wrapped: Decodable { var git: GitOverview }
        let wrapped: Wrapped = try await get("api/projects/\(escape(projectId))/git")
        return wrapped.git
    }

    func usageReport(sinceMs: Timestamp, untilMs: Timestamp, resolution: String, timeZone: String) async throws -> UsageReport {
        struct Wrapped: Decodable { var usage: UsageReport }
        let wrapped: Wrapped = try await get("api/usage", query: [
            URLQueryItem(name: "since", value: String(sinceMs)),
            URLQueryItem(name: "until", value: String(untilMs)),
            URLQueryItem(name: "resolution", value: resolution),
            URLQueryItem(name: "tz", value: timeZone),
        ])
        return wrapped.usage
    }

    func remoteStatus() async throws -> RemoteStatus {
        try await get("api/remote")
    }

    private struct WrappedDevice: Decodable { var device: RemoteDevice }

    func renameDevice(_ id: String, name: String) async throws -> RemoteDevice {
        let wrapped: WrappedDevice = try await send(
            "PATCH", "api/remote/devices/\(escape(id))", body: ["name": AnyEncodable(name)]
        )
        return wrapped.device
    }

    func setDeviceRole(_ id: String, role: String) async throws -> RemoteDevice {
        let wrapped: WrappedDevice = try await send(
            "PATCH", "api/remote/devices/\(escape(id))", body: ["role": AnyEncodable(role)]
        )
        return wrapped.device
    }

    func revokeDevice(_ id: String) async throws {
        var request = makeRequest(url("api/remote/devices/\(escape(id))"))
        request.httpMethod = "DELETE"
        let _: IgnoredBody = try await perform(request)
    }

    func revokeOtherDevices() async throws -> Int {
        var request = makeRequest(url("api/remote/devices"))
        request.httpMethod = "DELETE"
        struct Wrapped: Decodable { var revoked: Int }
        let wrapped: Wrapped = try await perform(request)
        return wrapped.revoked
    }

    // MARK: transport

    private func escape(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    }

    private func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        return components.url!
    }

    /// EVERY request funnels through here, so no endpoint can forget the
    /// pairing credential.
    private func makeRequest(_ url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        if let deviceToken {
            request.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await perform(makeRequest(url(path, query: query)))
    }

    /// Pre-pairing reachability: the one route that answers strangers. Also
    /// the version signature — `proto`/`appVersion` are absent on cockpits
    /// older than the field (treat missing proto as 1).
    func ping() async throws -> Pong {
        try await perform(makeRequest(url("api/ping")))
    }

    private func post<T: Decodable>(_ path: String, body: [String: AnyEncodable]) async throws -> T {
        try await send("POST", path, body: body)
    }

    private func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], body: B) async throws -> T {
        var request = makeRequest(url(path, query: query))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await perform(request)
    }

    /// A raw read that keeps the response's content type.
    private func rawFile(_ request: URLRequest) async throws -> RawFile {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw EngineAPIError.transport(error)
        }
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if let body = try? JSONDecoder().decode(EngineErrorBody.self, from: data) {
                throw EngineAPIError.engine(code: body.error.code, message: body.error.message, status: status)
            }
            throw EngineAPIError.badResponse(status: status)
        }
        return RawFile(data: data, contentType: http?.value(forHTTPHeaderField: "content-type"))
    }

    /// DECODED OFF THE CALLER'S EXECUTOR. Every store that calls this is
    /// `@MainActor`, and a struct method inherits the caller's isolation, so
    /// a session snapshot with its tool outputs was being parsed on the main
    /// thread — on a reconnect, at the same moment as the inbox's. The bytes
    /// go to a detached task and only the value comes back.
    private func perform<T: Decodable & Sendable>(_ request: URLRequest) async throws -> T {
        let (data, status) = try await raw(request)
        return try await Task.detached(priority: .userInitiated) {
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                throw EngineAPIError.incompatible(status: status)
            }
        }.value
    }

    private func raw(_ request: URLRequest) async throws -> Data {
        try await raw(request).0
    }

    /// The transport half of `perform`: the bytes of a 2xx, or the engine's
    /// typed error. Split out so the snapshot cache can keep what the cockpit
    /// sent without parsing it.
    private func raw(_ request: URLRequest) async throws -> (Data, Int) {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw EngineAPIError.transport(error)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if let body = try? JSONDecoder().decode(EngineErrorBody.self, from: data) {
                throw EngineAPIError.engine(code: body.error.code, message: body.error.message, status: status)
            }
            throw EngineAPIError.badResponse(status: status)
        }
        return (data, status)
    }
}

extension HTTPEngineAPI: PanelAPI {
    func projects() async throws -> [Project] {
        let list: ProjectList = try await get("api/projects")
        return list.projects
    }

    func sessionFiles(_ id: EngineID) async throws -> WorkspaceListing {
        struct Wrapped: Decodable { var listing: WorkspaceListing }
        let wrapped: Wrapped = try await get("api/sessions/\(escape(id))/files")
        return wrapped.listing
    }

    func sessionFile(_ id: EngineID, path: String) async throws -> WorkspaceFile {
        struct Wrapped: Decodable { var file: WorkspaceFile }
        let wrapped: Wrapped = try await get("api/sessions/\(escape(id))/files", query: [URLQueryItem(name: "path", value: path)])
        return wrapped.file
    }

    func writeSessionFile(_ id: EngineID, path: String, text: String, expectedSha256: String) async throws -> WorkspaceWriteResult {
        try await send(
            "PUT", "api/sessions/\(escape(id))/files",
            query: [URLQueryItem(name: "path", value: path)],
            body: ["text": AnyEncodable(text), "expectedSha256": AnyEncodable(expectedSha256)]
        )
    }

    func sessionFileRaw(_ id: EngineID, path: String) async throws -> RawFile {
        try await rawFile(makeRequest(url("api/sessions/\(escape(id))/files/raw", query: [URLQueryItem(name: "path", value: path)])))
    }

    func sessionTable(_ id: EngineID, path: String, offset: Int, limit: Int, sort: String?, desc: Bool) async throws -> TableWindow {
        var query = [
            URLQueryItem(name: "path", value: path),
            URLQueryItem(name: "offset", value: String(offset)),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        if let sort { query.append(URLQueryItem(name: "sort", value: sort)) }
        if desc { query.append(URLQueryItem(name: "desc", value: "1")) }
        return try await get("api/sessions/\(escape(id))/data/table", query: query)
    }

    func attachments(_ id: EngineID, tag: String?) async throws -> [TurnAttachment] {
        struct Wrapped: Decodable {
            var attachments: [TurnAttachment]
            private enum CodingKeys: String, CodingKey { case attachments }
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                attachments = try c.decode([Skippable<TurnAttachment>].self, forKey: .attachments).compactMap(\.value)
            }
        }
        let wrapped: Wrapped = try await get("api/sessions/\(escape(id))/attachments", query: tag.map { [URLQueryItem(name: "tag", value: $0)] } ?? [])
        return wrapped.attachments
    }

    func attachmentBytes(_ id: EngineID, attachmentId: EngineID) async throws -> RawFile {
        try await rawFile(makeRequest(url("api/sessions/\(escape(id))/attachments/\(escape(attachmentId))")))
    }

    func tagAttachment(_ id: EngineID, attachmentId: EngineID, tags: [String]) async throws -> TurnAttachment {
        struct Wrapped: Decodable { var attachment: TurnAttachment }
        let wrapped: Wrapped = try await send("PATCH", "api/sessions/\(escape(id))/attachments/\(escape(attachmentId))", body: ["tags": AnyEncodable(tags)])
        return wrapped.attachment
    }

    func ds<T: Decodable & Sendable>(_ id: EngineID, method: String, body: JSONValue) async throws -> T {
        try await door("ds", id, method: method, body: body)
    }

    func latex<T: Decodable & Sendable>(_ id: EngineID, method: String, body: JSONValue) async throws -> T {
        try await door("latex", id, method: method, body: body)
    }

    /// The plugin doors. A decode failure here is a body this build does not
    /// model, not a cockpit on another version, so it surfaces as its own
    /// sentence rather than the snapshot's "very different versions".
    private func door<T: Decodable & Sendable>(_ door: String, _ id: EngineID, method: String, body: JSONValue) async throws -> T {
        // `method` may carry a slash (`notebook/run`); each segment is its own path part.
        let path = "api/sessions/\(escape(id))/\(door)/" + method.split(separator: "/").map { escape(String($0)) }.joined(separator: "/")
        var request = makeRequest(url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, status) = try await raw(request)
        return try await Task.detached(priority: .userInitiated) {
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                throw EngineAPIError.engine(code: "unexpected_answer", message: "The Mac answered \(door)/\(method) in a shape this app cannot read.", status: status)
            }
        }.value
    }
}

/// GET /api/ping — reachability plus the cockpit's version signature.
struct Pong: Decodable {
    var ok: Bool
    /// Pairing-protocol number; nil on cockpits older than the field = 1.
    var proto: Int?
    var appVersion: String?
}

/// Some calls only care that the server said yes.
struct IgnoredBody: Decodable {
    init(from decoder: Decoder) {}
}

/// Heterogeneous JSON bodies without a bespoke Encodable per endpoint.
struct AnyEncodable: Encodable {
    private let encodeFn: (Encoder) throws -> Void
    init<T: Encodable>(_ value: T) {
        encodeFn = { try value.encode(to: $0) }
    }
    func encode(to encoder: Encoder) throws {
        try encodeFn(encoder)
    }
}
