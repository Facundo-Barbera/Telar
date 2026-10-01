import Foundation
import Testing
import UIKit
@testable import TelarMobile

@MainActor @Suite struct SentAttachmentsTests {
    @Test func aTurnsAttachmentsReachItsTranscriptRow() throws {
        let turn = try JSONDecoder().decode(Turn.self, from: Data(#"""
        {"runId":"run_1","sessionId":"s","sequence":1,"state":"completed","input":"what is this?",
         "acceptedAt":1,"updatedAt":2,
         "attachments":[
           {"id":"att_1","name":"shot.png","mediaType":"image/png","bytes":12,"path":"/x/att_1"},
           {"id":"att_2","name":"report.pdf","mediaType":"application/pdf","bytes":4096,"path":"/x/att_2"}]}
        """#.utf8))

        let row = projectJournal(turns: [turn], items: [], events: []).first

        #expect(row?.attachments?.map(\.name) == ["shot.png", "report.pdf"])
        #expect(row?.attachments?.last?.mediaType == "application/pdf")
    }

    @Test func aTurnWithoutAttachmentsHasNone() throws {
        let turn = try JSONDecoder().decode(Turn.self, from: Data(#"""
        {"runId":"run_1","sessionId":"s","sequence":1,"state":"completed","input":"hi","acceptedAt":1,"updatedAt":2}
        """#.utf8))
        #expect(projectJournal(turns: [turn], items: [], events: []).first?.attachments == nil)
    }

    private func tempCache() -> AttachmentCache {
        AttachmentCache(root: FileManager.default.temporaryDirectory.appending(path: "attachment-cache-\(UUID().uuidString)"))
    }

    @Test func openingAFileDownloadsItOnceUnderItsOwnName() async {
        let cache = tempCache()
        var fetches = 0
        let fetch: (EngineID, EngineID) async throws -> RawFile = { _, _ in
            fetches += 1
            return RawFile(data: Data("%PDF".utf8), contentType: "application/pdf")
        }

        let first = await cache.fileURL(host: nil, session: "s", attachmentId: "att_2", name: "report.pdf", fetch: fetch)
        let second = await cache.fileURL(host: nil, session: "s", attachmentId: "att_2", name: "report.pdf", fetch: fetch)

        #expect(first?.lastPathComponent == "report.pdf")
        #expect(first == second)
        #expect(fetches == 1)
        #expect(first.flatMap { try? Data(contentsOf: $0) } == Data("%PDF".utf8))
    }

    @Test func aFailedDownloadGivesNoFile() async {
        let url = await tempCache().fileURL(host: nil, session: "s", attachmentId: "gone", name: "a.txt") { _, _ in
            throw URLError(.badServerResponse)
        }
        #expect(url == nil)
    }

    @Test func bytesStoredAtUploadAreReadBackWithoutTheNetwork() {
        let cache = tempCache()
        let host = UUID()
        cache.store(Data("png".utf8), host: host, session: "s", attachmentId: "att_1", name: "shot.png")
        #expect(cache.cached(host: host, session: "s", attachmentId: "att_1") == Data("png".utf8))
        #expect(cache.cached(host: nil, session: "s", attachmentId: "att_1") == nil)
    }

    private func photo(width: CGFloat = 3000, height: CGFloat = 2000) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).pngData { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    @Test func aSentPhotoIsHeldAtThumbnailSizeNotFullSize() async {
        let cache = tempCache()
        cache.store(photo(), host: nil, session: "s", attachmentId: "att_1", name: "shot.png")

        let image = await cache.image(host: nil, session: "s", attachmentId: "att_1", side: Thumbnail.tile) { _, _ in
            throw URLError(.notConnectedToInternet)
        }

        let pixels = image?.cgImage.map { max($0.width, $0.height) }
        #expect(pixels == Int(Thumbnail.tile))
    }

    @Test func aNameCannotEscapeItsFolder() {
        #expect(AttachmentCache.fileName("../../etc/passwd") == ".._.._etc_passwd")
        #expect(AttachmentCache.fileName("  ") == "attachment")
        #expect(AttachmentCache.fileName("..") == "attachment")
    }
}
