import Foundation
import Testing
@testable import TelarMobile

private final class UploadStub: URLProtocol {
    nonisolated(unsafe) static var seen: [URLRequest] = []
    nonisolated(unsafe) static var status = 201

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var request = self.request
        if request.httpBody == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
            defer { buffer.deallocate() }
            while stream.hasBytesAvailable {
                let read = stream.read(buffer, maxLength: 4096)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            stream.close()
            request.httpBody = data
        }
        Self.seen.append(request)
        let body = Self.status == 201
            ? #"{"attachment":{"id":"att_up","name":"notes.pdf","mediaType":"application/pdf","bytes":3,"path":"/x"}}"#
            : #"{"error":{"code":"invalid_request","message":"attachment is larger than the engine accepts"}}"#
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor @Suite(.serialized) struct SessionStoreAttachmentsTests {
    private let host = UUID()
    private let session = "s_\(UUID().uuidString.prefix(8))"

    private func api() -> HTTPEngineAPI {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [UploadStub.self]
        return HTTPEngineAPI(baseURL: URL(string: "http://stub.test:3000")!, session: URLSession(configuration: config))
    }

    private func cleanUp() {
        UserDefaults.standard.removeObject(forKey: "telar.draft.\(host).\(session).attachments")
    }

    @Test func anUploadSendsTheRawBytesWithTheirTypeAndName() async {
        UploadStub.seen = []
        UploadStub.status = 201
        defer { cleanUp() }
        let store = SessionStore(api: api(), sessionId: session, hostId: host)

        let failure = await store.attach(data: Data("pdf".utf8), name: "my notes.pdf", mediaType: "application/pdf")

        #expect(failure == nil)
        let request = UploadStub.seen.first
        #expect(request?.httpMethod == "POST")
        #expect(request?.url?.path() == "/api/sessions/\(session)/attachments")
        #expect(request?.value(forHTTPHeaderField: "content-type") == "application/pdf")
        #expect(request?.value(forHTTPHeaderField: "x-telar-attachment-name") == "my%20notes.pdf")
        #expect(request?.httpBody == Data("pdf".utf8))
        #expect(store.pendingAttachments.map(\.id) == ["att_up"])
    }

    @Test func aRefusedUploadSaysWhichFileAndWhy() async {
        UploadStub.status = 400
        defer { cleanUp() }
        let store = SessionStore(api: api(), sessionId: session, hostId: host)

        let failure = await store.attach(data: Data("big".utf8), name: "huge.mov", mediaType: "video/quicktime")

        #expect(failure?.hasPrefix("Couldn't upload huge.mov") == true)
        #expect(store.pendingAttachments.isEmpty)
    }
}
