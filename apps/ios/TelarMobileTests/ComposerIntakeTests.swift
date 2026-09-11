import Foundation
import Testing
import UniformTypeIdentifiers
@testable import TelarMobile

/// The rules a paste and a drop share, without a pasteboard: which type out of
/// everything an item offers is worth loading, what the engine is told the
/// bytes are, what the file is called, and what is too big to take.
@Suite struct ComposerIntakeTests {
    // MARK: which type to load

    @Test func aConcretePayloadBeatsAFileURL() {
        // A Files drag registers the file's own type AND a URL into another
        // app's sandbox. Loading the bytes is the one that still works by the
        // time the upload starts.
        #expect(ComposerIntake.best(of: ["public.file-url", "public.png"]) == .png)
        #expect(ComposerIntake.best(of: [UTType.fileURL.identifier, UTType.pdf.identifier]) == .pdf)
    }

    @Test func anImageWinsOverEverythingElseOnOffer() {
        // Photos offers several; the picture is the point.
        #expect(ComposerIntake.best(of: ["public.plain-text", "public.jpeg"]) == .jpeg)
    }

    @Test func plainTextIsTakenOnlyWhenNothingElseIsOffered() {
        #expect(ComposerIntake.best(of: ["public.plain-text"]) == .plainText)
        #expect(ComposerIntake.best(of: []) == nil)
    }

    @Test func anUnknownIdentifierIsSkippedRatherThanGuessed() {
        #expect(ComposerIntake.best(of: ["not.a.real.type", "public.png"]) == .png)
    }

    // MARK: what the engine is told

    @Test func theMediaTypeComesFromTheSystemWhereverItKnowsOne() {
        #expect(ComposerIntake.mediaType(for: .png) == "image/png")
        #expect(ComposerIntake.mediaType(for: .jpeg) == "image/jpeg")
        #expect(ComposerIntake.mediaType(for: .pdf) == "application/pdf")
        #expect(ComposerIntake.mediaType(for: .plainText) == "text/plain")
    }

    @Test func anUntypedPayloadIsBytesRatherThanAWrongGuess() {
        // The cockpit renders on the media type, so calling an unknown blob an
        // image would show a broken picture instead of a download.
        #expect(ComposerIntake.mediaType(for: nil) == "application/octet-stream")
        #expect(ComposerIntake.mediaType(for: .data) == "application/octet-stream")
    }

    // MARK: what it is called

    @Test func aClipboardImageWithNoNameStillGetsOneWithAnExtension() {
        #expect(ComposerIntake.fileName(nil, type: .png) == "pasted.png")
        #expect(ComposerIntake.fileName("", type: .jpeg) == "pasted.jpeg")
        #expect(ComposerIntake.fileName(nil, type: .png, fallback: "dropped") == "dropped.png")
    }

    @Test func aSuggestedNameKeepsItsOwnExtension() {
        #expect(ComposerIntake.fileName("report.pdf", type: .pdf) == "report.pdf")
        // …and one that arrived without an extension gains the type's.
        #expect(ComposerIntake.fileName("report", type: .pdf) == "report.pdf")
    }

    @Test func aNamelessUntypedPayloadIsStillNamed() {
        #expect(ComposerIntake.fileName(nil, type: nil) == "pasted.dat")
    }

    // MARK: the cap

    @Test func aFileWithinTheCapIsTaken() {
        let result = ComposerIntake.take(Data(repeating: 0, count: 1024), name: "log.txt", type: .plainText)
        #expect(result.file == ComposerFile(data: Data(repeating: 0, count: 1024), name: "log.txt", mediaType: "text/plain"))
        #expect(result.refusal == nil)
    }

    @Test func aFileOverTheCapIsRefusedInWordsThatNameIt() {
        // A refusal is shown; nothing is silently dropped, because a file that
        // simply never appears reads as the app being broken.
        let result = ComposerIntake.take(Data(repeating: 0, count: ComposerIntake.byteCap + 1), name: "huge.mov", type: .movie)
        #expect(result.file == nil)
        let refusal = try? #require(result.refusal)
        #expect(refusal?.contains("huge.mov") == true)
        #expect(refusal?.contains("25.0 MB") == true)
    }

    @Test func exactlyTheCapIsStillTaken() {
        #expect(ComposerIntake.take(Data(repeating: 0, count: ComposerIntake.byteCap), name: "edge.bin", type: .data).file != nil)
    }

    @Test func anEmptyPayloadIsRefusedRatherThanUploaded() {
        #expect(ComposerIntake.take(Data(), name: "nothing.png", type: .png).refusal?.contains("empty") == true)
    }

    @Test func anImageIsMarkedAsOneForTheChip() {
        #expect(ComposerIntake.take(Data([1]), name: "a.png", type: .png).file?.isImage == true)
        #expect(ComposerIntake.take(Data([1]), name: "a.pdf", type: .pdf).file?.isImage == false)
    }

    @Test func thePreviewCapIsBelowTheUploadCap() {
        // A picture too big to hold in memory for a 72pt chip is still
        // attachable; it just wears the document glyph.
        #expect(ComposerIntake.previewCap < ComposerIntake.byteCap)
    }
}
