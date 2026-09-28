import Foundation
import Testing
@testable import TelarMobile

/// Its own stub class: StubURLProtocol's handler is a static, and suites run
/// in parallel — sharing it with NetworkingTests is a data race dressed as
/// flaky assertions.
final class PairingStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else { return }
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

@Suite(.serialized) struct PairingTests {
    @Test func parseAcceptsFragmentTokens() throws {
        let https = try #require(Pairing.parsePairingURL("https://mac.tail.ts.net/pair#token=tlr_abc123"))
        #expect(https.base.absoluteString == "https://mac.tail.ts.net")
        #expect(https.token == "tlr_abc123")

        let http = try #require(Pairing.parsePairingURL("http://100.110.136.102:3000/pair#token=tlr_x"))
        #expect(http.base.absoluteString == "http://100.110.136.102:3000")
        #expect(http.token == "tlr_x")

        // The current cockpit's secret is eight digits.
        let code = try #require(Pairing.parsePairingURL("http://100.110.136.102:3000/pair#token=37410745"))
        #expect(code.token == "37410745")
    }

    @Test func parseRejectsWhatMustBeRejected() {
        // A query-string token has been in a server log; refuse it.
        #expect(Pairing.parsePairingURL("http://mac:3000/pair?token=tlr_x") == nil)
        // Neither a code nor a token, missing token, non-http schemes.
        #expect(Pairing.parsePairingURL("http://mac:3000/pair#token=nope") == nil)
        #expect(Pairing.parsePairingURL("http://mac:3000/pair#token=1234567") == nil)
        #expect(Pairing.parsePairingURL("http://mac:3000/pair#token=12345678a") == nil)
        #expect(Pairing.parsePairingURL("http://mac:3000/pair#other=1") == nil)
        #expect(Pairing.parsePairingURL("ftp://mac/pair#token=tlr_x") == nil)
        #expect(Pairing.parsePairingURL("not a url") == nil)
    }

    @Test func exchangePostsAndReturnsTheDeviceToken() async throws {
        PairingStubURLProtocol.handler = { request in
            #expect(request.url?.path() == "/api/pair")
            #expect(request.httpMethod == "POST")
            let body = try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String]
            #expect(body?["token"] == "tlr_pairing")
            #expect(body?["deviceName"] == "Test iPhone")
            #expect(body?["platform"] == "ios")
            return (200, Data(#"{"deviceToken":"tlr_device","deviceId":"dev_1","deviceName":"Test iPhone","addresses":["http://192.168.1.20:3000","http://100.110.1.2:3000"]}"#.utf8))
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PairingStubURLProtocol.self]
        let token = try await Pairing.exchange(
            base: URL(string: "http://stub.test:3000")!, token: "tlr_pairing",
            deviceName: "Test iPhone", session: URLSession(configuration: config)
        )
        #expect(token.deviceToken == "tlr_device")
        #expect(token.addresses == ["http://192.168.1.20:3000", "http://100.110.1.2:3000"])
    }

    @Test func exchangeNeedsOnlyTheTokenFromAnOlderOrNewerCockpit() async throws {
        PairingStubURLProtocol.handler = { _ in
            // No deviceId/deviceName, plus a field this build doesn't know.
            (200, Data(#"{"deviceToken":"tlr_minimal","futureField":42}"#.utf8))
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PairingStubURLProtocol.self]
        let token = try await Pairing.exchange(
            base: URL(string: "http://stub.test:3000")!, token: "tlr_pairing",
            deviceName: "Phone", session: URLSession(configuration: config)
        )
        #expect(token.deviceToken == "tlr_minimal")
        #expect(token.addresses == nil)
    }

    @Test func expiredPairingSurfacesTheGateError() async {
        PairingStubURLProtocol.handler = { _ in
            (401, Data(#"{"error":{"code":"cockpit_unauthorized","message":"That pairing code has expired or was already used."}}"#.utf8))
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PairingStubURLProtocol.self]
        do {
            _ = try await Pairing.exchange(
                base: URL(string: "http://stub.test:3000")!, token: "tlr_old",
                deviceName: "Phone", session: URLSession(configuration: config)
            )
            Issue.record("expected throw")
        } catch let error as EngineAPIError {
            #expect(error.isUnauthorized)
        } catch {
            Issue.record("unexpected error type")
        }
    }

    @Test func requestsCarryTheBearerExactlyWhenPaired() async throws {
        PairingStubURLProtocol.handler = { request in
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tlr_device")
            return (200, Data(#"{"ok":true}"#.utf8))
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PairingStubURLProtocol.self]
        let paired = HTTPEngineAPI(
            baseURL: URL(string: "http://stub.test:3000")!,
            deviceToken: "tlr_device",
            session: URLSession(configuration: config)
        )
        #expect(try await paired.ping().ok)

        PairingStubURLProtocol.handler = { request in
            #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
            return (200, Data(#"{"ok":true}"#.utf8))
        }
        let open = HTTPEngineAPI(
            baseURL: URL(string: "http://stub.test:3000")!,
            session: URLSession(configuration: config)
        )
        // An old cockpit's bare {ok:true}: proto reads as nil (treat as 1).
        let pong = try await open.ping()
        #expect(pong.ok)
        #expect(pong.proto == nil)
    }

    @Test func aGatedApiCallMapsToUnauthorized() async {
        PairingStubURLProtocol.handler = { _ in
            (401, Data(#"{"error":{"code":"cockpit_unauthorized","message":"Pair this device with the Telar cockpit to use it."}}"#.utf8))
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PairingStubURLProtocol.self]
        let api = HTTPEngineAPI(baseURL: URL(string: "http://stub.test:3000")!, session: URLSession(configuration: config))
        do {
            _ = try await api.health()
            Issue.record("expected throw")
        } catch let error as EngineAPIError {
            #expect(error.isUnauthorized)
            #expect(error.errorDescription?.contains("pairing code") == true)
        } catch {
            Issue.record("unexpected error type")
        }
    }
}
