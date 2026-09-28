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

    // MARK: what the field's own paste hands over

    @Test func aClipboardImageIsAnAttachmentRatherThanText() {
        // The whole point: the field's Paste must offer the picture, which it
        // only does once something says the clipboard is worth taking.
        #expect(ComposerIntake.isAttachment(["public.png"]))
        #expect(ComposerIntake.isAttachment(["public.jpeg"]))
        // Safari copies a picture AND its text in one item; the picture wins.
        #expect(ComposerIntake.isAttachment(["public.png", "public.utf8-plain-text"]))
    }

    @Test func textIsLeftToTheFieldThatIsAlreadyGoodAtIt() {
        #expect(ComposerIntake.isAttachment(["public.utf8-plain-text"]) == false)
        #expect(ComposerIntake.isAttachment(["public.plain-text"]) == false)
        // Rich text and markup are still text: pasting a copied paragraph
        // must type it out, not attach an .rtf.
        #expect(ComposerIntake.isAttachment(["public.rtf"]) == false)
        #expect(ComposerIntake.isAttachment(["public.html"]) == false)
        #expect(ComposerIntake.isAttachment([]) == false)
    }

    @Test func aLinkIsTextButAFileIsAFile() {
        // A copied link pastes as its address; a file URL is a file even
        // though it is also a URL, which is why it is asked about first.
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
        // An image-only clipboard is the case that had no Paste at all.
        #expect(ComposerIntake.hasAttachment(in: [["public.png"]]))
        #expect(ComposerIntake.hasAttachment(in: [["public.utf8-plain-text"], ["public.png"]]))
        #expect(ComposerIntake.hasAttachment(in: [["public.utf8-plain-text"]]) == false)
        #expect(ComposerIntake.hasAttachment(in: []) == false)
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
