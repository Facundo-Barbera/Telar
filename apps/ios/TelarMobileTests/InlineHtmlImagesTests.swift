import Foundation
import Testing
@testable import TelarMobile

/// The pre-pass that turns an inline `<img>` into a Markdown image before
/// anything parses the text. MarkdownUI renders every inline tag but `<br>` as
/// its own literal source, so without this a notebook cell — or a transcript
/// where an agent pasted one — showed the tag.
@Suite struct InlineHtmlImagesTests {
    @Test func aPlainImgBecomesAMarkdownImage() {
        #expect(rewriteInlineImages("<img src=\"fig.png\">") == "![](fig.png)")
    }

    @Test func anAltAttributeBecomesTheLabel() {
        #expect(rewriteInlineImages("<img src=\"fig.png\" alt=\"a residual plot\">") == "![a residual plot](fig.png)")
        // Order does not matter, and single quotes are as common as double.
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
        // MarkdownUI already turns `<br>` into a line break; touching it here
        // would take that away.
        #expect(rewriteInlineImages("one<br>two") == "one<br>two")
        #expect(rewriteInlineImages("one<br/>two") == "one<br/>two")
    }

    @Test func everyOtherInlineTagStaysLiteral() {
        // The decision is that a cell may be an image or a block, not that it
        // may be arbitrary HTML.
        #expect(rewriteInlineImages("a <span class=\"x\">b</span> c") == "a <span class=\"x\">b</span> c")
        #expect(rewriteInlineImages("<b>bold</b>") == "<b>bold</b>")
    }

    @Test func textWithNoTagsIsReturnedUntouched() {
        #expect(rewriteInlineImages("# Heading\n\nplain prose") == "# Heading\n\nplain prose")
    }

    @Test func anImgWithNoSourceIsLeftAsItWas() {
        // An empty `![]()` would claim there is an image to draw.
        #expect(rewriteInlineImages("<img alt=\"nothing\">") == "<img alt=\"nothing\">")
        #expect(rewriteInlineImages("<img src=\"\">") == "<img src=\"\">")
    }

    @Test func entitiesInAttributesAreDecoded() {
        #expect(rewriteInlineImages("<img src=\"a.png?x=1&amp;y=2\">") == "![](a.png?x=1&y=2)")
    }

    @Test func aTargetWithSpacesGetsAngleBrackets() {
        // Without them the link ends at the space and the rest becomes prose.
        #expect(rewriteInlineImages("<img src=\"my figure.png\">") == "![](<my figure.png>)")
    }

    @Test func bracketsInAnAltDoNotCloseTheLabelEarly() {
        #expect(rewriteInlineImages("<img src=\"a.png\" alt=\"fig [1]\">") == "![fig \\[1\\]](a.png)")
    }

    // MARK: where a relative source points

    @Test func aRelativeSourceResolvesAgainstTheNotebooksDirectory() {
        // Relative to the NOTEBOOK, not the workspace root — the same rule
        // Jupyter itself uses.
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
        // The raw route serves the workspace and nothing above it, so there is
        // no path out to ask for.
        #expect(resolveNotebookImagePath("../../../etc/passwd", notebookPath: "a/b.ipynb") == "etc/passwd")
    }

    @Test func aNetworkOrDataSourceIsNotTheWorkspacesToResolve() {
        #expect(resolveNotebookImagePath("https://example.com/a.png", notebookPath: "a/b.ipynb") == nil)
        #expect(resolveNotebookImagePath("http://example.com/a.png", notebookPath: "a/b.ipynb") == nil)
        #expect(resolveNotebookImagePath("data:image/png;base64,AAA", notebookPath: "a/b.ipynb") == nil)
    }
}

/// Which markdown gets handed to a web view, and which stays prose.
@Suite struct HtmlBlockRoutingTests {
    @Test func aBlockOnItsOwnIsAnHtmlBlock() {
        #expect(soleHtmlBlock("<div class=\"warn\">careful</div>") != nil)
        #expect(soleHtmlBlock("<table><tr><td>a</td></tr></table>") != nil)
        #expect(soleHtmlBlock("  <details><summary>more</summary>x</details>  ") != nil)
    }

    @Test func proseWithATagInTheMiddleStaysMarkdown() {
        // Rendering the whole paragraph as HTML would lose the Markdown around
        // the tag, which is the more common intent.
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
