import Foundation
import SwiftUI

/// The frame clock for a paced reveal — 30Hz, not the display's rate.
///
/// EVERY FRAME RE-PARSES THE MESSAGE. `MarkdownText` splits the math out and
/// hands the rest to a markdown renderer, so a reveal frame costs a parse of
/// the prefix, not a cheap substring. At the rates this pacer sustains the
/// visible prefix grows by several characters per frame either way, so 30Hz
/// reads as continuous while halving the parse budget of a display-rate loop.
let revealFrameMs = 33

/// Drives one message's reveal: the pure pacer plus the frame clock.
///
/// A CLASS, NOT `@State` OVER THE STRUCT, because the frame loop and the
/// text-change path both write it while `body` only ever reads it. SwiftUI is
/// explicit that state must not be mutated during `body`; the web hook gets to
/// adjust state mid-render and this is the shape that does not need to.
@MainActor @Observable final class RevealPacer {
    private var pace = revealState(0, 0)
    /// The text `pace` was last measured against. The replacement check needs
    /// the old STRING, not just its length.
    private var rendered = ""
    private var seeded = false

    /// SEEDED AT THE FULL LENGTH: a row scrolled out of a long transcript and
    /// back remounts its view, and starting at zero would replay a reply the
    /// reader already watched.
    func seed(_ text: String) {
        guard !seeded else { return }
        seeded = true
        pace = revealState(text.count, monotonicMs())
        rendered = text
    }

    /// New text from the fold. A REPLACEMENT RESTARTS: a revised answer of the
    /// same or greater length would otherwise render a prefix of the NEW text
    /// at the OLD progress — words in an order the model never wrote.
    func ingest(_ text: String) {
        guard seeded else { return seed(text) }
        let now = monotonicMs()
        pace = isReplacement(rendered, pace.shown, text)
            ? revealState(text.count, now)
            : stepReveal(pace, text.count, now)
        rendered = text
    }

    /// One frame. Caught up is the common case and costs nothing.
    func advance() {
        guard seeded, pace.shown < Double(pace.target) else { return }
        pace = advanceReveal(pace, monotonicMs())
    }

    func visible(_ target: String) -> String { revealText(target, pace.shown) }
}

/// MONOTONIC, NOT WALL CLOCK. `systemUptime` cannot step backwards when the
/// clock is corrected, which would hand `advanceReveal` a negative elapsed.
func monotonicMs() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }

/// An assistant message, paced while it streams.
///
/// WHY THIS EXISTS. The engine streams smoothly — a 19ms median gap between
/// deltas — but the phone TAILS ONCE A SECOND, so a second of that arrives in
/// one page and the fold hands this view the whole second at once. Painting it
/// raw is what made short replies land as a single block. The pacer spends each
/// burst over the interval that produced it, which is what the web has done
/// since b0f61ba1.
struct StreamingMarkdown: View {
    let text: String
    /// The item is still open — mirrors the web's `running(item)`.
    let streaming: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pacer = RevealPacer()

    /// REDUCED MOTION SHOWS THE TEXT, not a slower animation of it. Settled
    /// text is the source string too: every exit from the pacer is `text`.
    private var shown: String {
        streaming && !reduceMotion ? pacer.visible(text) : text
    }

    var body: some View {
        MarkdownText(text: shown)
            .onAppear { pacer.seed(text) }
            // The fold hands over a longer string; the pacer takes the arrival
            // and its timestamp. One frame may render the old progress against
            // the new text — still a prefix, because the text only grows.
            .onChange(of: text) { _, next in pacer.ingest(next) }
            .task(id: streaming) {
                guard streaming else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(revealFrameMs))
                    if Task.isCancelled { return }
                    pacer.advance()
                }
            }
    }
}
