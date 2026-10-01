import Foundation
import Testing
import UniformTypeIdentifiers
@testable import TelarMobile

@Suite struct ComposerIntakeTests {
    @Test func aConcretePayloadBeatsAFileURL() {
        #expect(ComposerIntake.best(of: ["public.file-url", "public.png"]) == .png)
        #expect(ComposerIntake.best(of: [UTType.fileURL.identifier, UTType.pdf.identifier]) == .pdf)
    }

    @Test func anImageWinsOverEverythingElseOnOffer() {
        #expect(ComposerIntake.best(of: ["public.plain-text", "public.jpeg"]) == .jpeg)
    }

    @Test func plainTextIsTakenOnlyWhenNothingElseIsOffered() {
        #expect(ComposerIntake.best(of: ["public.plain-text"]) == .plainText)
        #expect(ComposerIntake.best(of: []) == nil)
    }

    @Test func anUnknownIdentifierIsSkippedRatherThanGuessed() {
        #expect(ComposerIntake.best(of: ["not.a.real.type", "public.png"]) == .png)
    }

    @Test func aClipboardImageIsAnAttachmentRatherThanText() {
        #expect(ComposerIntake.isAttachment(["public.png"]))
        #expect(ComposerIntake.isAttachment(["public.jpeg"]))
        #expect(ComposerIntake.isAttachment(["public.png", "public.utf8-plain-text"]))
    }

    @Test func textIsLeftToTheFieldThatIsAlreadyGoodAtIt() {
        #expect(ComposerIntake.isAttachment(["public.utf8-plain-text"]) == false)
        #expect(ComposerIntake.isAttachment(["public.plain-text"]) == false)
        #expect(ComposerIntake.isAttachment(["public.rtf"]) == false)
        #expect(ComposerIntake.isAttachment(["public.html"]) == false)
        #expect(ComposerIntake.isAttachment([]) == false)
    }

    @Test func aLinkIsTextButAFileIsAFile() {
        #expect(ComposerIntake.isAttachment(["public.url"]) == false)
        #expect(ComposerIntake.isAttachment(["public.url", "public.utf8-plain-text"]) == false)
        #expect(ComposerIntake.isAttachment(["public.file-url"]))
    }

    @Test func documentsAndMediaGoInTheStrip() {
        #expect(ComposerIntake.isAttachment(["com.adobe.pdf"]))
        #expect(ComposerIntake.isAttachment(["public.movie"]))
        #expect(ComposerIntake.isAttachment(["public.mp3"]))
    }

    @Test func oneAttachableItemIsEnoughToOfferPaste() {
        #expect(ComposerIntake.hasAttachment(in: [["public.png"]]))
        #expect(ComposerIntake.hasAttachment(in: [["public.utf8-plain-text"], ["public.png"]]))
        #expect(ComposerIntake.hasAttachment(in: [["public.utf8-plain-text"]]) == false)
        #expect(ComposerIntake.hasAttachment(in: []) == false)
    }

    @Test func theMediaTypeComesFromTheSystemWhereverItKnowsOne() {
        #expect(ComposerIntake.mediaType(for: .png) == "image/png")
        #expect(ComposerIntake.mediaType(for: .jpeg) == "image/jpeg")
        #expect(ComposerIntake.mediaType(for: .pdf) == "application/pdf")
        #expect(ComposerIntake.mediaType(for: .plainText) == "text/plain")
    }

    @Test func anUntypedPayloadIsBytesRatherThanAWrongGuess() {
        #expect(ComposerIntake.mediaType(for: nil) == "application/octet-stream")
        #expect(ComposerIntake.mediaType(for: .data) == "application/octet-stream")
    }

    @Test func aClipboardImageWithNoNameStillGetsOneWithAnExtension() {
        #expect(ComposerIntake.fileName(nil, type: .png) == "pasted.png")
        #expect(ComposerIntake.fileName("", type: .jpeg) == "pasted.jpeg")
        #expect(ComposerIntake.fileName(nil, type: .png, fallback: "dropped") == "dropped.png")
    }

    @Test func aSuggestedNameKeepsItsOwnExtension() {
        #expect(ComposerIntake.fileName("report.pdf", type: .pdf) == "report.pdf")
        #expect(ComposerIntake.fileName("report", type: .pdf) == "report.pdf")
    }

    @Test func aNamelessUntypedPayloadIsStillNamed() {
        #expect(ComposerIntake.fileName(nil, type: nil) == "pasted.dat")
    }

    @Test func aFileWithinTheCapIsTaken() {
        let result = ComposerIntake.take(Data(repeating: 0, count: 1024), name: "log.txt", type: .plainText)
        #expect(result.file == ComposerFile(data: Data(repeating: 0, count: 1024), name: "log.txt", mediaType: "text/plain"))
        #expect(result.refusal == nil)
    }

    @Test func aFileOverTheCapIsRefusedInWordsThatNameIt() {
        let result = ComposerIntake.take(Data(repeating: 0, count: ComposerIntake.byteCap + 1), name: "huge.mov", type: .movie)
        #expect(result.file == nil)
        let refusal = try? #require(result.refusal)
        #expect(refusal?.contains("huge.mov") == true)
        #expect(refusal?.contains("20.0 MB") == true)
    }

    @Test func exactlyTheCapIsStillTaken() {
        #expect(ComposerIntake.take(Data(repeating: 0, count: ComposerIntake.byteCap), name: "edge.bin", type: .data).file != nil)
    }

    @Test func anEmptyPayloadIsRefusedRatherThanUploaded() {
        #expect(ComposerIntake.take(Data(), name: "nothing.png", type: .png).refusal?.contains("empty") == true)
    }

    @Test func thePreviewCapIsBelowTheUploadCap() {
        #expect(ComposerIntake.previewCap < ComposerIntake.byteCap)
    }

    private func tempFile(_ name: String, bytes: Int) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "intake-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appending(path: name)
        try Data(repeating: 1, count: bytes).write(to: url)
        return url
    }

    @Test func aPickedFileKeepsItsNameAndType() throws {
        let file = ComposerIntake.take(fileAt: try tempFile("report.pdf", bytes: 10)).file
        #expect(file?.name == "report.pdf")
        #expect(file?.mediaType == "application/pdf")
        #expect(file?.data.count == 10)
    }

    @Test func aPickedFileOverTheEngineLimitIsRefusedByName() throws {
        let result = ComposerIntake.take(fileAt: try tempFile("film.mov", bytes: ComposerIntake.byteCap + 1))
        #expect(result.file == nil)
        #expect(result.refusal?.hasPrefix("film.mov is") == true)
    }

    @Test func aPickedFileThatVanishedIsRefused() {
        let gone = FileManager.default.temporaryDirectory.appending(path: "missing-\(UUID().uuidString).txt")
        #expect(ComposerIntake.take(fileAt: gone).refusal?.contains("could not be read") == true)
    }
}
