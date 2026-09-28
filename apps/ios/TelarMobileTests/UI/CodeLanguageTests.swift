import Foundation
import Testing
@testable import TelarMobile

/// The mapping and the cap, which are the parts that decide whether colour is
/// right or wrong. The rendering belongs to Highlightr and is not tested here.
@Suite struct CodeLanguageTests {
    // MARK: from a path

    @Test func ordinaryExtensionsMapToTheirLanguage() {
        #expect(CodeLanguage.named("Sources/App/Main.swift") == "swift")
        #expect(CodeLanguage.named("train.py") == "python")
        #expect(CodeLanguage.named("app/page.tsx") == "typescript")
        #expect(CodeLanguage.named("lib/util.mjs") == "javascript")
        #expect(CodeLanguage.named("Cargo/src/main.rs") == "rust")
        #expect(CodeLanguage.named("report/main.tex") == "latex")
    }

    @Test func theExtensionIsReadCaseInsensitively() {
        // A checkout from a case-insensitive filesystem has README.MD in it.
        #expect(CodeLanguage.named("READ.MD") == "markdown")
        #expect(CodeLanguage.named("Main.SWIFT") == "swift")
    }

    @Test func filesThatAreTheirNameAreRecognisedWithoutOne() {
        #expect(CodeLanguage.named("Dockerfile") == "dockerfile")
        #expect(CodeLanguage.named("deploy/Makefile") == "makefile")
        #expect(CodeLanguage.named(".gitignore") == "gitignore")
        #expect(CodeLanguage.named("CMakeLists.txt") == "cmake")
    }

    @Test func anUnknownExtensionIsNotGuessedAt() {
        // Colouring Swift as Ruby is worse than plain monospace: the colours
        // then assert something false about the code.
        #expect(CodeLanguage.named("archive.bin") == nil)
        #expect(CodeLanguage.named("notes") == nil)
        #expect(CodeLanguage.named("data.parquet") == nil)
    }

    // MARK: from a fence

    @Test func aFenceNamesItsLanguageDirectlyOrByAlias() {
        #expect(CodeLanguage.fenced("swift") == "swift")
        #expect(CodeLanguage.fenced("ts") == "typescript")
        #expect(CodeLanguage.fenced("sh") == "bash")
        #expect(CodeLanguage.fenced("console") == "bash")
        #expect(CodeLanguage.fenced("py") == "python")
    }

    @Test func onlyTheFirstWordOfAnInfoStringCounts() {
        // ```python title="train.py" and ```{.python} are both in the wild.
        #expect(CodeLanguage.fenced("python title=train.py") == "python")
        #expect(CodeLanguage.fenced("{.python}") == "python")
        #expect(CodeLanguage.fenced("  swift  ") == "swift")
    }

    @Test func aFenceThatSaysPlainTextIsNotHighlighted() {
        #expect(CodeLanguage.fenced("text") == nil)
        #expect(CodeLanguage.fenced("plaintext") == nil)
        #expect(CodeLanguage.fenced("none") == nil)
    }

    @Test func anUnfencedBlockHasNoLanguage() {
        #expect(CodeLanguage.fenced(nil) == nil)
        #expect(CodeLanguage.fenced("") == nil)
        #expect(CodeLanguage.fenced("   ") == nil)
    }

    // MARK: the cap

    @Test func aFileWithinTheCapIsWorthColouring() {
        #expect(CodeLanguage.worthHighlighting("let x = 1", language: "swift"))
        #expect(CodeLanguage.worthHighlighting(String(repeating: "a", count: CodeLanguage.sizeCap), language: "swift"))
    }

    @Test func aFileOverTheCapStaysPlain() {
        // highlight.js is a regex pass in JavaScriptCore; past this it is a
        // visible stall for colour nobody reads on a phone.
        #expect(!CodeLanguage.worthHighlighting(String(repeating: "a", count: CodeLanguage.sizeCap + 1), language: "swift"))
    }

    @Test func theCapCountsBytesNotCharacters() {
        // A file of emoji is four times its character count on the wire, and
        // it is the bytes JavaScriptCore has to walk.
        let emoji = String(repeating: "😀", count: CodeLanguage.sizeCap / 4)
        #expect(emoji.count < CodeLanguage.sizeCap)
        #expect(CodeLanguage.worthHighlighting(emoji, language: "swift"))
        #expect(!CodeLanguage.worthHighlighting(emoji + "😀", language: "swift"))
    }

    @Test func noLanguageIsNeverWorthColouring() {
        #expect(!CodeLanguage.worthHighlighting("anything", language: nil))
    }
}
