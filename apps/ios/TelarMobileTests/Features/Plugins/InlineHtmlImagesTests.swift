import Foundation
import Testing
@testable import TelarMobile

@Suite struct InlineHtmlImagesTests {
    @Test func aPlainImgBecomesAMarkdownImage() {
        #expect(rewriteInlineImages("<img src=\"fig.png\">") == "![](fig.png)")
    }

    @Test func anAltAttributeBecomesTheLabel() {
        #expect(rewriteInlineImages("<img src=\"fig.png\" alt=\"a residual plot\">") == "![a residual plot](fig.png)")
        #expect(rewriteInlineImages("<img alt='chart' src='a/b.svg'/>") == "![chart](a/b.svg)")
    }

    @Test func anImgInsideAParagraphKeepsTheProseAroundIt() {
        let out = rewriteInlineImages("Before <img src=\"x.png\" alt=\"x\"> after.")
        #expect(out == "Before ![x](x.png) after.")
    }

    @Test func severalImagesAreAllRewritten() {
        #expect(rewriteInlineImages("<img src=\"a.png\"><img src=\"b.png\">") == "![](a.png)![](b.png)")
    }

    @Test func aBreakIsLeftAloneSoItStaysALineBreak() {
        #expect(rewriteInlineImages("one<br>two") == "one<br>two")
        #expect(rewriteInlineImages("one<br/>two") == "one<br/>two")
    }

    @Test func everyOtherInlineTagStaysLiteral() {
        #expect(rewriteInlineImages("a <span class=\"x\">b</span> c") == "a <span class=\"x\">b</span> c")
        #expect(rewriteInlineImages("<b>bold</b>") == "<b>bold</b>")
    }

    @Test func textWithNoTagsIsReturnedUntouched() {
        #expect(rewriteInlineImages("# Heading\n\nplain prose") == "# Heading\n\nplain prose")
    }

    @Test func anImgWithNoSourceIsLeftAsItWas() {
        #expect(rewriteInlineImages("<img alt=\"nothing\">") == "<img alt=\"nothing\">")
        #expect(rewriteInlineImages("<img src=\"\">") == "<img src=\"\">")
    }

    @Test func entitiesInAttributesAreDecoded() {
        #expect(rewriteInlineImages("<img src=\"a.png?x=1&amp;y=2\">") == "![](a.png?x=1&y=2)")
    }

    @Test func aTargetWithSpacesGetsAngleBrackets() {
        #expect(rewriteInlineImages("<img src=\"my figure.png\">") == "![](<my figure.png>)")
    }

    @Test func bracketsInAnAltDoNotCloseTheLabelEarly() {
        #expect(rewriteInlineImages("<img src=\"a.png\" alt=\"fig [1]\">") == "![fig \\[1\\]](a.png)")
    }

    @Test func aRelativeSourceResolvesAgainstTheNotebooksDirectory() {
        #expect(resolveNotebookImagePath("fig.png", notebookPath: "analysis/etl.ipynb") == "analysis/fig.png")
        #expect(resolveNotebookImagePath("./out/fig.png", notebookPath: "analysis/etl.ipynb") == "analysis/out/fig.png")
        #expect(resolveNotebookImagePath("../shared/fig.png", notebookPath: "analysis/deep/etl.ipynb") == "analysis/shared/fig.png")
    }

    @Test func aNotebookAtTheRootResolvesToTheBareName() {
        #expect(resolveNotebookImagePath("fig.png", notebookPath: "etl.ipynb") == "fig.png")
    }

    @Test func aWorkspaceAbsolutePathIsAlreadyWhatTheRouteWants() {
        #expect(resolveNotebookImagePath("/data/fig.png", notebookPath: "analysis/etl.ipynb") == "data/fig.png")
    }

    @Test func climbingPastTheRootIsClamped() {
        #expect(resolveNotebookImagePath("../../../etc/passwd", notebookPath: "a/b.ipynb") == "etc/passwd")
    }

    @Test func aNetworkOrDataSourceIsNotTheWorkspacesToResolve() {
        #expect(resolveNotebookImagePath("https://example.com/a.png", notebookPath: "a/b.ipynb") == nil)
        #expect(resolveNotebookImagePath("http://example.com/a.png", notebookPath: "a/b.ipynb") == nil)
        #expect(resolveNotebookImagePath("data:image/png;base64,AAA", notebookPath: "a/b.ipynb") == nil)
    }
}

@Suite struct HtmlBlockRoutingTests {
    @Test func aBlockOnItsOwnIsAnHtmlBlock() {
        #expect(soleHtmlBlock("<div class=\"warn\">careful</div>") != nil)
        #expect(soleHtmlBlock("<table><tr><td>a</td></tr></table>") != nil)
        #expect(soleHtmlBlock("  <details><summary>more</summary>x</details>  ") != nil)
    }

    @Test func proseWithATagInTheMiddleStaysMarkdown() {
        #expect(soleHtmlBlock("Some **bold** and <div>a div</div>") == nil)
        #expect(soleHtmlBlock("<div>a div</div> then prose") == nil)
    }

    @Test func aLoneInlineTagIsNotABlock() {
        #expect(soleHtmlBlock("<span>x</span>") == nil)
        #expect(soleHtmlBlock("<b>x</b>") == nil)
    }

    @Test func plainMarkdownIsNeverAnHtmlBlock() {
        #expect(soleHtmlBlock("# Heading") == nil)
        #expect(soleHtmlBlock("") == nil)
    }
}
