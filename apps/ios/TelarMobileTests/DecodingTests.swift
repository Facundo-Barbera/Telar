import Foundation
import Testing
@testable import TelarMobile

/// Anchor for locating the test bundle — Swift Testing has no XCTestCase to
/// hang `Bundle(for:)` off, so a throwaway class does it.
private final class FixtureAnchor {}

func fixture(_ name: String) throws -> Data {
    let bundle = Bundle(for: FixtureAnchor.self)
    guard let url = bundle.url(forResource: name, withExtension: "json") else {
        throw CocoaError(.fileNoSuchFile)
    }
    return try Data(contentsOf: url)
}

/// The fixtures are REAL responses captured from a live cockpit (see
/// apps/ios/README.md). Shapes, not content, are what they pin.
@Suite struct DecodingTests {
    @Test func healthDecodes() throws {
        let health = try JSONDecoder().decode(EngineHealth.self, from: fixture("health"))
        #expect(!health.daemonId.isEmpty)
        #expect(health.worker.registered)
    }

    @Test func liveSessionsDecode() throws {
        let live = try JSONDecoder().decode(LiveSessions.self, from: fixture("live-sessions"))
        #expect(!live.sessions.isEmpty)
        #expect(!live.projects.isEmpty)
        // Every session names a project that exists in the same payload, or
        // none (the project-less master chat is legitimate).
        let projectIds = Set(live.projects.map(\.id))
        for session in live.sessions {
            if let projectId = session.projectId {
                #expect(projectIds.contains(projectId))
            }
        }
    }

    /// THE LIVE LIST SENDS ROWS, NOT WHOLE SESSIONS (#459).
    ///
    /// That route is what the phone polls; on the owner's store it was 318 KB a
    /// read for 267 conversations, most of it fields no row on this phone draws.
    /// The engine now sends only what a rail renders — no `environmentId`, no
    /// `providerInstanceId`, no `runtimeMode`, no `detached`, no `resumeCursor`,
    /// and no `workspace.baseRef`.
    ///
    /// EVERY ONE OF THOSE WAS ALREADY OPTIONAL HERE, which is why this build
    /// needs no change to read the narrower answer — and this test is what says
    /// so out loud, so a later edit cannot quietly make one of them required and
    /// blank the phone's list against a current Mac. The fields the rail DOES
    /// draw are asserted present: losing one of those is a blank row, not a
    /// blank list, which is the harder bug to see.
    @Test func theLiveListDecodesWithoutTheFieldsNoRowDraws() throws {
        let lean = #"""
        {"sessions":[{"id":"session_one","projectId":"project_one","title":"Lean the live list",
          "state":"active","createdAt":1700000000000,"updatedAt":1700000001000,"driver":"claude",
          "envMode":"worktree","model":{"instanceId":"claude","model":"claude-opus-5[1m]"},
          "workspace":{"mode":"worktree","path":"/tmp/w","branch":"telar/459-lean"},
          "activity":"working","activityAt":1700000001000,"settledOverride":"active"}],
         "projects":[{"id":"project_one","name":"Telar"}]}
        """#
        let live = try JSONDecoder().decode(LiveSessions.self, from: Data(lean.utf8))
        let session = try #require(live.sessions.first)
        #expect(session.id == "session_one")
        #expect(session.activity == .working)
        #expect(session.workspace.branch == "telar/459-lean")
        #expect(session.model?.model == "claude-opus-5[1m]")
        #expect(session.settledOverride == "active")
        // Absent, and absent has to keep meaning what it meant: the engine's own
        // defaults, never "unknown" and never a blank row.
        #expect(session.providerInstanceId == nil)
        #expect(session.resumeCursor == nil)
        #expect(session.workspace.baseRef == nil)
        #expect(session.runtimeMode == "approval-required")
        #expect(session.detached == false)
        // No policy on this payload: an engine that predates the fold, which the
        // store reads as "ask for it yourself, once a minute" and not as "off".
        #expect(live.inbox == nil)
    }

    /// THE SETTLING WINDOW RIDES THE LIST (#459) — one read a pass instead of
    /// three. Nil is not "no window": it is a Mac too old to stamp one, and the
    /// store falls back to the rationed request it used to make every time.
    @Test func theLiveListCarriesTheSettlingWindowAndToleratesItsAbsence() throws {
        let decode = { (json: String) in try JSONDecoder().decode(LiveSessions.self, from: Data(json.utf8)) }
        #expect(try decode(#"{"sessions":[],"projects":[]}"#).inbox == nil)
        #expect(try decode(#"{"sessions":[],"projects":[],"inbox":{"autoSettleAfterHours":72}}"#).inbox?.autoSettleAfterHours == 72)
        // "Off" is a real answer and must survive as one, not become the default.
        #expect(try decode(#"{"sessions":[],"projects":[],"inbox":{"autoSettleAfterHours":null}}"#).inbox?.autoSettleAfterHours == nil)
        // And a policy this build cannot read costs the window, never the list.
        #expect(try decode(#"{"sessions":[],"projects":[],"inbox":"never"}"#).inbox == nil)
    }

    /// THE ARRANGEMENT RIDES THE LIVE READ (#306) — and every part of it is
    /// optional, at both levels. The fixture predates the field, so this pins
    /// the tolerance the wire needs rather than the fixture's content: a Mac
    /// too old to send `layout` decodes to nil (which the phone reads as "keep
    /// what you have"), and a layout with no row arrangements decodes to empty
    /// lists rather than failing and costing the project order stored beside
    /// them.
    @Test func theLiveReadCarriesAnOptionalArrangementAtEveryLevel() throws {
        let decode = { (json: String) in try JSONDecoder().decode(LiveSessions.self, from: Data(json.utf8)) }
        #expect(try decode(#"{"sessions":[],"projects":[]}"#).layout == nil)

        let old = try decode(#"{"sessions":[],"projects":[],"layout":{"projectOrder":["p2","p1"]}}"#)
        #expect(old.layout == SidebarLayout(projectOrder: ["p2", "p1"]))

        let whole = try decode(#"{"sessions":[],"projects":[],"layout":{"projectOrder":["p1"],"sessionOrder":{"p1":["s2","s1"]},"pinnedOrder":["s9"]}}"#)
        #expect(whole.layout == SidebarLayout(projectOrder: ["p1"], sessionOrder: ["p1": ["s2", "s1"]], pinnedOrder: ["s9"]))

        // A layout this build cannot read costs the arrangement, never the
        // list — the same tolerance `Skippable` gives the rows beside it.
        #expect(try decode(#"{"sessions":[],"projects":[],"layout":"b,a"}"#).layout == nil)
    }

    /// WHICH REPOSITORY A PROJECT IS A CHECKOUT OF, and the absence of one.
    /// The engine derives `remoteUrl` on its metadata refresh and sends it
    /// already reduced; a Mac too old to derive it, an unversioned directory
    /// and a checkout with no origin all send nothing, and nothing must stay
    /// nothing rather than becoming a name to fold two strangers on.
    @Test func projectRefsCarryTheRepositoryTheyAreACheckoutOf() throws {
        let decode = { (json: String) in try JSONDecoder().decode(LiveSessions.self, from: Data(json.utf8)) }
        let live = try decode(#"""
        {"sessions":[],"projects":[
          {"id":"p1","name":"Telar","icon":"abc","remoteUrl":"github.com/owner/repo"},
          {"id":"p2","name":"scratch"}
        ]}
        """#)
        #expect(live.projects.first?.remoteUrl == "github.com/owner/repo")
        #expect(live.projects.last?.remoteUrl == nil)
    }

    /// WHO IS WORKING FOR WHOM, on the wire — the two relationships the rail's
    /// tree is made of. `assignments` rides the live list as a map keyed by
    /// session id (the engine folds it over each session's whole queue);
    /// `startedFrom` rides the session itself.
    ///
    /// AN ABSENT MAP IS THE ORDINARY ANSWER, not a failure: a cockpit that does
    /// not forward the field sends none, and the rail then draws exactly the
    /// flat list it always did rather than losing the list.
    @Test func theLiveReadCarriesWhoIsWorkingForWhom() throws {
        let decode = { (json: String) in try JSONDecoder().decode(LiveSessions.self, from: Data(json.utf8)) }
        let session = #"""
        {"id":"child","projectId":"p","title":"Child","createdAt":1,"updatedAt":1,"activity":"working",
         "driver":"claude","workspace":{"mode":"local","path":"/tmp"},"startedFrom":{"sessionId":"coord","runId":"run_1"}}
        """#
        let live = try decode(#"""
        {"sessions":[\#(session)],"projects":[],
         "assignments":{"child":[{"taskRunId":"run_1","fromSessionId":"coord","runId":"run_1","receivedAt":1,"scope":"the parser"}]}}
        """#)
        #expect(live.sessions.first?.startedFrom == SessionProvenance(sessionId: "coord", runId: "run_1"))
        #expect(live.assignments["child"]?.first?.fromSessionId == "coord")
        #expect(live.assignments["child"]?.first?.scope == "the parser")
        // Outstanding: no outcome, not unresolved.
        #expect(live.assignments["child"]?.first?.outcome == nil)

        #expect(try decode(#"{"sessions":[],"projects":[]}"#).assignments.isEmpty)
        // A map this build cannot read costs the tree, never the list.
        #expect(try decode(#"{"sessions":[],"projects":[],"assignments":"nope"}"#).assignments.isEmpty)
    }

    @Test func snapshotDecodes() throws {
        let snapshot = try JSONDecoder().decode(SessionSnapshot.self, from: fixture("snapshot"))
        #expect(!snapshot.turns.isEmpty)
        #expect(!snapshot.items.isEmpty)
        #expect(snapshot.requests.count == 2)
        for request in snapshot.requests {
            if case .unknown = request.detail {
                Issue.record("known request kind decoded as unknown")
            }
        }
    }

    @Test func eventPagesDecode() throws {
        for name in ["events-page", "events-tasks"] {
            let page = try JSONDecoder().decode(EventPage.self, from: fixture(name))
            #expect(!page.events.isEmpty)
            #expect(page.cursor > 0)
            // Envelope ids are strictly increasing — the replay contract.
            let ids = page.events.map(\.id)
            #expect(ids == ids.sorted())
            #expect(Set(ids).count == ids.count)
        }
    }

    @Test func taskEventsCarryTasks() throws {
        let page = try JSONDecoder().decode(EventPage.self, from: fixture("events-tasks"))
        let started = page.events.compactMap { event -> AgentTask? in
            if case .taskStarted(let task) = event.payload { return task }
            return nil
        }
        #expect(!started.isEmpty)
    }

    @Test func unknownItemTypeRendersNotThrows() throws {
        let data = Data("""
        {"id":"item_x","runId":"run_x","sessionId":"s","status":"completed",
         "detail":{"type":"brand_new_thing","widget":42},"startedAt":1}
        """.utf8)
        let item = try JSONDecoder().decode(Item.self, from: data)
        #expect(item.detail == .unknown(label: "brand_new_thing"))
    }

    @Test func unknownEventTypeIsInertNotFatal() throws {
        let data = Data("""
        {"events":[
          {"id":1,"at":10,"sessionId":"s","type":"future.event","surprise":true},
          {"id":2,"at":11,"sessionId":"s","type":"turn.stopped"}
         ],"cursor":2,"more":false}
        """.utf8)
        let page = try JSONDecoder().decode(EventPage.self, from: data)
        #expect(page.events.count == 2)
        if case .none = page.events[0].payload {} else { Issue.record("unknown type should carry no payload") }
        #expect(page.events[0].type == "future.event")
        #expect(page.cursor == 2)
    }

    @Test func malformedRowIsSkippedRestSurvives() throws {
        let data = Data("""
        {"events":[
          {"not":"an event"},
          {"id":5,"at":11,"sessionId":"s","type":"turn.started"}
         ],"cursor":5,"more":false}
        """.utf8)
        let page = try JSONDecoder().decode(EventPage.self, from: data)
        #expect(page.events.count == 1)
        #expect(page.events[0].id == 5)
    }

    @Test func unknownEnumValuesFallBack() throws {
        let data = Data("""
        {"id":"s1","projectId":"p","title":"T","state":"hibernating",
         "createdAt":1,"updatedAt":2,"driver":"claude",
         "workspace":{"mode":"local","path":"/x"},"runtimeMode":"auto",
         "detached":false,"activity":"levitating"}
        """.utf8)
        let session = try JSONDecoder().decode(Session.self, from: data)
        #expect(session.state == .active)
        #expect(session.activity == .idle)
    }

    @Test func userInputRequestDecodesFields() throws {
        let data = Data("""
        {"id":"req_1","runId":"run_1","sessionId":"s","state":"open","openedAt":1,
         "detail":{"kind":"user_input","prompt":"Pick one",
           "fields":[{"key":"choice_a","label":"Which?","kind":"choice",
                      "choices":["red","blue"],"required":true}]}}
        """.utf8)
        let request = try JSONDecoder().decode(EngineRequest.self, from: data)
        guard case .userInput(let prompt, let fields) = request.detail else {
            Issue.record("expected user_input"); return
        }
        #expect(prompt == "Pick one")
        #expect(fields.first?.choices == ["red", "blue"])
        #expect(request.isOpen)
    }

    /// One `request.opened` row copied verbatim out of the live journal
    /// (`select value from events where value like '%"user_input"%' ...`), not
    /// typed by hand. Only the events-page envelope around it is ours — the
    /// event itself is exactly what the engine wrote.
    private static let journalUserInputEvent = #"""
    {"id":1895,"at":1789074205111,"sessionId":"session_d016f60f8e27488d9f832539fb90b9fd","runId":"run_211867ec91144c5cbae3e648a1d12552","type":"request.opened","request":{"id":"req_toolu_018f7ocXFLHU7zFbe3gZ6KSm","runId":"run_211867ec91144c5cbae3e648a1d12552","sessionId":"session_d016f60f8e27488d9f832539fb90b9fd","state":"open","detail":{"kind":"user_input","prompt":"The agent needs your input to continue.","fields":[{"key":"I can't find Terra in this ChatGPT build. Where should I set it?","label":"I can't find Terra in this ChatGPT build. Where should I set it?","kind":"choice","choices":["It's under Create image","Switch back to Work mode","Just send with the default","I'll set Terra myself"],"required":true}]},"openedAt":1789074205111,"notified":false}}
    """#

    private static func decodeUserInputField(_ event: String) throws -> UserInputField {
        let page = try JSONDecoder().decode(
            EventPage.self,
            from: Data(#"{"events":[\#(event)],"cursor":1895,"more":false}"#.utf8)
        )
        guard case .requestOpened(let request) = page.events.first?.payload,
              case .userInput(_, let fields) = request.detail,
              let field = fields.first
        else { throw CocoaError(.coderValueNotFound) }
        return field
    }

    @Test func journalChoiceFieldHasNoMultipleAndStaysSingle() throws {
        // Every `choice` the engine has ever sent omits `multiple` — this is
        // the shape in the journal today, and it must keep meaning one pick.
        let field = try Self.decodeUserInputField(Self.journalUserInputEvent)
        #expect(field.kind == "choice")
        #expect(field.choices?.count == 4)
        #expect(field.multiple == nil)
        #expect(field.isMultiSelect == false)
    }

    @Test func multipleTrueDecodesAsMultiSelect() throws {
        // The same verbatim journal event, with `"multiple":true` spliced into
        // the field object by string edit. The journal carries no such sample
        // yet because the feature did not exist — so this is the one place the
        // shape is asserted rather than observed, and everything around the
        // inserted key stays exactly as the engine wrote it.
        let withMultiple = Self.journalUserInputEvent
            .replacingOccurrences(of: #""kind":"choice""#, with: #""kind":"choice","multiple":true"#)
        let field = try Self.decodeUserInputField(withMultiple)
        #expect(field.multiple == true)
        #expect(field.isMultiSelect)
        #expect(field.choices?.count == 4)
    }

    @Test func browserControlEventDecodesController() throws {
        let data = Data("""
        {"events":[
          {"id":9,"at":10,"sessionId":"s","runId":"run_1","type":"browser.control.changed","controller":"human"}
         ],"cursor":9,"more":false}
        """.utf8)
        let page = try JSONDecoder().decode(EventPage.self, from: data)
        guard case .browserControlChanged(let controller) = page.events[0].payload else {
            Issue.record("expected browser.control.changed payload"); return
        }
        #expect(controller == "human")
    }

    @Test func secretAccessRequestDecodesCandidates() throws {
        // The 1Password fill card: metadata only, by contract — origin,
        // field kinds, and domain-matched candidates. Approving it sends
        // answers.item back; the values never reach this app.
        let data = Data("""
        {"id":"req_2","runId":"run_1","sessionId":"s","state":"open","openedAt":1,
         "detail":{"kind":"secret_access","secret":{
           "origin":"https://github.com",
           "fields":[{"kind":"username"},{"kind":"password"}],
           "candidates":[{"id":"item_gh","title":"GitHub","vault":"Personal","domain":"github.com"}],
           "hint":"github"}}}
        """.utf8)
        let request = try JSONDecoder().decode(EngineRequest.self, from: data)
        guard case .secretAccess(let secret) = request.detail else {
            Issue.record("expected secret_access"); return
        }
        #expect(secret.origin == "https://github.com")
        #expect(secret.fields.map(\.kind) == ["username", "password"])
        #expect(secret.candidates.first?.title == "GitHub")
        #expect(secret.candidates.first?.domain == "github.com")
        #expect(request.isOpen)
    }
}

@Suite struct EngineRevisionFixtures {
    @Test func openCodeUsesTheSameSessionAndStreamingContract() throws {
        let snapshot = try JSONDecoder().decode(SessionSnapshot.self, from: fixture("engine-revision"))
        #expect(snapshot.session.driver == "opencode")
        #expect(snapshot.session.resumeCursor == "ses_fixture")
        #expect(snapshot.turns.count == 2)
        #expect(snapshot.turns[1].state == .queued)
        #expect(snapshot.items.first?.streamed == "Hello")
        #expect(snapshot.items.first?.streamedThrough != nil)
    }
}
