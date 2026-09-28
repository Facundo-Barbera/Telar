import Foundation
import Testing
@testable import TelarMobile

/// URLProtocol stub: each test registers a handler keyed by path.
final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else { return }
        // httpBody is emptied by URLSession; the stream carries it.
        var request = self.request
        if request.httpBody == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            let size = 4096
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
            defer { buffer.deallocate() }
            while stream.hasBytesAvailable {
                let read = stream.read(buffer, maxLength: size)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            stream.close()
            request.httpBody = data
        }
        let (status, body) = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private func stubAPI() -> HTTPEngineAPI {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubURLProtocol.self]
    return HTTPEngineAPI(baseURL: URL(string: "http://stub.test:3000")!, session: URLSession(configuration: config))
}

@Suite(.serialized) struct NetworkingTests {
    @Test func runIdShape() {
        let a = RunID.newRunId()
        let b = RunID.newRunId()
        #expect(a.wholeMatch(of: /run_[0-9a-f]{32}/) != nil)
        #expect(a != b)
    }

    @Test func filesRoutesCarryPathAndPrecondition() async throws {
        StubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path(), request.url?.query()) {
            case ("GET", "/api/sessions/s/files", nil):
                return (200, Data(#"{"listing":{"workspacePath":"/x","repository":true,"files":["a.md"],"source":"git","truncated":false,"readAt":1}}"#.utf8))
            case ("GET", "/api/sessions/s/files", "path=docs/a.md"):
                return (200, Data(#"{"file":{"path":"docs/a.md","text":"hi","bytes":2,"sha256":"h1","binary":false,"truncated":false}}"#.utf8))
            case ("PUT", "/api/sessions/s/files", "path=docs/a.md"):
                let body = try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
                #expect(body?["text"] as? String == "hello")
                #expect(body?["expectedSha256"] as? String == "h1")
                return (200, Data(#"{"written":false,"refusal":"conflict","sha256":"h9"}"#.utf8))
            default:
                Issue.record("unexpected \(request.httpMethod ?? "") \(request.url?.absoluteString ?? "")")
                return (500, Data())
            }
        }
        let api = stubAPI()
        #expect(try await api.sessionFiles("s").files == ["a.md"])
        #expect(try await api.sessionFile("s", path: "docs/a.md").sha256 == "h1")
        let result = try await api.writeSessionFile("s", path: "docs/a.md", text: "hello", expectedSha256: "h1")
        #expect(result == .refused(.conflict, sha256: "h9"))
    }

    @Test func pluginDoorsPostEachMethodSegment() async throws {
        StubURLProtocol.handler = { request in
            #expect(request.httpMethod == "POST")
            #expect(request.url?.path() == "/api/sessions/s/ds/notebook/run")
            let body = try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
            #expect(body?["path"] as? String == "n.ipynb")
            #expect(body?["cellId"] as? String == "c1")
            return (200, Data(#"{"results":[],"notebook":{"path":"n.ipynb","sha256":"h","cellCount":0,"cells":[]}}"#.utf8))
        }
        let run = try await stubAPI().notebookRun("s", path: "n.ipynb", cellId: "c1")
        #expect(run.notebook.path == "n.ipynb")
    }

    @Test func anUnreadableDoorAnswerIsItsOwnError() async {
        StubURLProtocol.handler = { _ in (200, Data("[1,2,3]".utf8)) }
        do {
            _ = try await stubAPI().kernel("s")
            Issue.record("expected a throw")
        } catch let error as EngineAPIError {
            if case .engine(let code, _, _) = error { #expect(code == "unexpected_answer") } else { Issue.record("wrong case \(error)") }
        } catch {
            Issue.record("wrong error \(error)")
        }
    }

    @Test func projectIconCarriesTheKeyAsTheCacheBuster() async throws {
        StubURLProtocol.handler = { request in
            #expect(request.url?.path() == "/api/projects/project_dud/icon")
            #expect(request.url?.query() == "v=sha-abc")
            return (200, Data([0x89, 0x50, 0x4E, 0x47]))
        }
        let data = try await stubAPI().projectIcon("project_dud", icon: "sha-abc")
        #expect(data == Data([0x89, 0x50, 0x4E, 0x47]))
    }

    @Test func submitSendsIdempotencyKeyAndAcceptsReplay() async throws {
        let turnJSON = """
        {"turn":{"runId":"run_abc","sessionId":"s","sequence":1,"state":"queued",
         "input":"hi","acceptedAt":1,"updatedAt":1},"replayed":true}
        """
        StubURLProtocol.handler = { request in
            #expect(request.url?.path() == "/api/sessions/s/turns")
            let body = try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
            #expect(body?["runId"] as? String == "run_abc")
            #expect(body?["input"] as? String == "hi")
            // 200 + replayed — the retry path is a SUCCESS, not an error.
            return (200, Data(turnJSON.utf8))
        }
        let result = try await stubAPI().submitTurn("s", runId: "run_abc", input: "hi")
        #expect(result.replayed)
        #expect(result.turn.runId == "run_abc")
    }

    @Test func withdrawingOneMessageDoesNotStopTheSession() async throws {
        StubURLProtocol.handler = { request in
            let body = try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
            #expect(body?["runId"] as? String == "run_one")
            #expect(body?["scope"] == nil)
            return (200, Data(#"{"stopped":true}"#.utf8))
        }
        try await stubAPI().stopTurn("s", runId: "run_one")
    }

    @Test func stopTargetsTheSessionIncludingPendingWork() async throws {
        StubURLProtocol.handler = { request in
            #expect(request.url?.path() == "/api/sessions/s/stop")
            #expect(request.httpMethod == "POST")
            let body = try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
            #expect(body?["scope"] as? String == "session")
            #expect(body?["runId"] == nil)
            return (200, Data(#"{"stopped":[]}"#.utf8))
        }
        try await stubAPI().stopSession("s")
    }

    @Test func engineErrorBodyBecomesTypedError() async {
        StubURLProtocol.handler = { _ in
            (503, Data(#"{"error":{"code":"engine_unavailable","message":"down"}}"#.utf8))
        }
        do {
            _ = try await stubAPI().health()
            Issue.record("expected throw")
        } catch let error as EngineAPIError {
            guard case .engine(let code, _, let status) = error else {
                Issue.record("wrong case"); return
            }
            #expect(code == "engine_unavailable")
            #expect(status == 503)
        } catch {
            Issue.record("unexpected error type")
        }
    }

    @Test func versionSkewIsNamedNotBlamedOnTheURL() async {
        // A 200 that doesn't decode proves the URL IS a cockpit — the two
        // ends are just on different versions.
        //
        // NOT `{}` ANY MORE, AND THAT IS A REAL CHANGE RATHER THAN A TWEAK.
        // `LiveSessions` decodes an absent `sessions`/`projects` to empty on
        // purpose since #459 — it is how one type reads both the full answer and
        // the conditional read's "unchanged" answer, and `SessionModels.swift`
        // says so where the decoder is. So `{}` is now a VALID body and this
        // probe stopped probing anything the day that landed; it went unnoticed
        // because nothing executed this suite until #755. A wrongly TYPED
        // `sessions` is undecodable under either shape, which is what this test
        // has always been about.
        StubURLProtocol.handler = { _ in (200, Data(#"{"sessions":"not an array"}"#.utf8)) }
        do {
            _ = try await stubAPI().liveSessions()
            Issue.record("expected throw")
        } catch let error as EngineAPIError {
            guard case .incompatible = error else {
                Issue.record("wrong case"); return
            }
            #expect(error.errorDescription?.contains("versions") == true)
            #expect(error.errorDescription?.contains("base URL") != true)
        } catch {
            Issue.record("unexpected error type")
        }
    }

    @Test func resolveRequestEncodesAnswers() async throws {
        StubURLProtocol.handler = { request in
            #expect(request.url?.path() == "/api/sessions/s/requests/req_9")
            let body = try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
            #expect(body?["decision"] as? String == "accept")
            let answers = body?["answers"] as? [String: Any]
            #expect(answers?["color"] as? String == "red")
            #expect(answers?["confirm"] as? Bool == true)
            return (200, Data("{}".utf8))
        }
        try await stubAPI().resolveRequest(
            "s", requestId: "req_9", decision: .accept, reason: nil,
            answers: ["color": .text("red"), "confirm": .bool(true)]
        )
    }

    @Test func resolveRequestEncodesMultiSelectAsAnArray() async throws {
        // A `choice` field marked `multiple` answers with the chosen labels,
        // in the question's own order — not a joined string.
        StubURLProtocol.handler = { request in
            let body = try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
            let answers = body?["answers"] as? [String: Any]
            #expect(answers?["toppings"] as? [String] == ["a", "b"])
            // The single-pick field beside it still goes as a bare string.
            #expect(answers?["size"] as? String == "large")
            return (200, Data("{}".utf8))
        }
        try await stubAPI().resolveRequest(
            "s", requestId: "req_10", decision: .accept, reason: nil,
            answers: ["toppings": .list(["a", "b"]), "size": .text("large")]
        )
    }

    @Test func eventsPassesCursor() async throws {
        StubURLProtocol.handler = { request in
            #expect(request.url?.query() == "after=41")
            return (200, Data(#"{"events":[],"cursor":41,"more":false}"#.utf8))
        }
        let page = try await stubAPI().events("s", after: 41)
        #expect(page.cursor == 41)
    }
}
