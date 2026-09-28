import Foundation
import Testing
@testable import TelarMobile

/// The web's math policy (`markdown-math.ts` + remark-math), on the phone's
/// pre-pass: `$$` only, single dollars are money, fences and code spans are
/// never math, and a lone one-line equation is promoted to display.
@Suite struct MathSegmentsTests {
    @Test func plainMarkdownIsOneRun() {
        #expect(splitMath("Hello **world**\n\n| a | b |\n|---|---|\n| 1 | 2 |") == [.markdown("Hello **world**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n")])
    }

    @Test func singleDollarsAreMoney() {
        let segments = splitMath("It costs $5 to $10 a month.")
        #expect(segments == [.markdown("It costs $5 to $10 a month.\n")])
    }

    @Test func multiLineDoubleDollarIsDisplay() {
        let segments = splitMath("Before\n\n$$\nR_t = \\frac{P_t}{P_{t-1}}\n$$\n\nAfter")
        #expect(segments == [.markdown("Before\n\n"), .display("R_t = \\frac{P_t}{P_{t-1}}"), .markdown("\nAfter\n")])
    }

    @Test func aStandaloneOneLineEquationIsPromotedToDisplay() {
        let segments = splitMath("Then:\n\n$$E = mc^2$$\n\nwhich is famous.")
        #expect(segments == [.markdown("Then:\n\n"), .display("E = mc^2"), .markdown("\nwhich is famous.\n")])
    }

    @Test func aMidSentenceEquationStaysInline() {
        let segments = splitMath("where $$x^2$$ is squared.")
        #expect(segments == [.markdown("where "), .inline("x^2"), .markdown(" is squared.\n")])
    }

    @Test func fencesAndCodeSpansAreNeverMath() {
        let fenced = splitMath("```\n$$ not math $$\n```")
        #expect(fenced == [.markdown("```\n$$ not math $$\n```\n")])
        let span = splitMath("Use `$$` to open math.")
        #expect(span == [.markdown("Use `$$` to open math.\n")])
    }

    @Test func anUnclosedOpenerIsText() {
        #expect(splitMath("Costs $$ a lot") == [.markdown("Costs $$ a lot\n")])
        #expect(splitMath("$$\nnever closed") == [.markdown("$$\nnever closed\n")])
    }
}
