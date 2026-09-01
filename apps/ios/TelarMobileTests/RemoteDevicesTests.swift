import Foundation
import Testing
@testable import TelarMobile

/// Own stub protocol: sharing StubURLProtocol's static handler across
/// parallel suites is a data race, so each suite carries its own class.
final class RemoteStubURLProtocol: URLProtocol {
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

private func stubAPI() -> HTTPEngineAPI {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [RemoteStubURLProtocol.self]
    return HTTPEngineAPI(baseURL: URL(string: "http://stub.test:3000")!, session: URLSession(configuration: config))
}

@Suite(.serialized) struct RemoteDevicesTests {
    @Test func statusDecodesDevicesAndCaller() async throws {
        let json = """
        {"requireAuth":true,
         "devices":[
          {"id":"dev_1","name":"Phone","createdAt":1000,"lastSeenAt":2000,"role":"full","platform":"ios"},
          {"id":"dev_2","name":"Browser","createdAt":1000,"role":"observer","platform":"browser"},
          {"id":"dev_3","name":"Old","createdAt":1000,"role":"full"}],
         "callerDeviceId":"dev_1","callerRole":"full"}
        """
        RemoteStubURLProtocol.handler = { request in
            #expect(request.url?.path() == "/api/remote")
            return (200, Data(json.utf8))
        }
        let status = try await stubAPI().remoteStatus()
        #expect(status.requireAuth)
        #expect(status.callerDeviceId == "dev_1")
        #expect(status.devices.count == 3)
        #expect(status.devices[1].role == "observer")
        #expect(status.devices[2].platform == nil)
    }

    @Test func renameAndRolePatchTheDeviceRoute() async throws {
        let device = #"{"device":{"id":"dev_1","name":"Pocket","createdAt":1,"role":"observer"}}"#
        RemoteStubURLProtocol.handler = { request in
            #expect(request.httpMethod == "PATCH")
            #expect(request.url?.path() == "/api/remote/devices/dev_1")
            return (200, Data(device.utf8))
        }
        let renamed = try await stubAPI().renameDevice("dev_1", name: "Pocket")
        #expect(renamed.name == "Pocket")
        let demoted = try await stubAPI().setDeviceRole("dev_1", role: "observer")
        #expect(demoted.role == "observer")
    }

    @Test func revokeOthersDeletesTheCollection() async throws {
        RemoteStubURLProtocol.handler = { request in
            #expect(request.httpMethod == "DELETE")
            #expect(request.url?.path() == "/api/remote/devices")
            return (200, Data(#"{"revoked":2}"#.utf8))
        }
        #expect(try await stubAPI().revokeOtherDevices() == 2)
    }

    @Test func olderCockpitPayloadsDecodeLeniently() throws {
        // No role (pre-roles cockpit), no callerDeviceId, one garbage row:
        // the page renders, the alien row is skipped, roles default to full.
        let json = """
        {"requireAuth":true,
         "devices":[
          {"id":"dev_1","name":"Phone","createdAt":1000},
          {"unexpected":"shape"},
          {"id":"dev_2","name":"Browser","createdAt":1000,"role":"observer"}]}
        """
        let status = try JSONDecoder().decode(RemoteStatus.self, from: Data(json.utf8))
        #expect(status.devices.count == 2)
        #expect(status.devices[0].role == "full")
        #expect(status.devices[1].role == "observer")
        #expect(status.callerDeviceId == nil)
    }

    @Test func evenEmptierPayloadFailsClosed() throws {
        let status = try JSONDecoder().decode(RemoteStatus.self, from: Data("{}".utf8))
        #expect(status.requireAuth)
        #expect(status.devices.isEmpty)
    }

    @Test func forbiddenSurfacesAsViewOnly() async {
        RemoteStubURLProtocol.handler = { _ in
            (403, Data(#"{"error":{"code":"cockpit_forbidden","message":"view only"}}"#.utf8))
        }
        do {
            _ = try await stubAPI().revokeOtherDevices()
            Issue.record("expected throw")
        } catch let error as EngineAPIError {
            #expect(error.isForbidden)
            #expect(error.errorDescription?.contains("viewing only") == true)
        } catch {
            Issue.record("wrong error type")
        }
    }
}
