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
