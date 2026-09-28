import Foundation
import SwiftUI

let revealFrameMs = 33

@MainActor @Observable final class RevealPacer {
    private var pace = revealState(0, 0)

    private var rendered = ""
    private var seeded = false

    func seed(_ text: String) {
        guard !seeded else { return }
        seeded = true
        pace = revealState(text.count, monotonicMs())
        rendered = text
    }

    func ingest(_ text: String) {
        guard seeded else { return seed(text) }
        let now = monotonicMs()
        pace = isReplacement(rendered, pace.shown, text)
            ? revealState(text.count, now)
            : stepReveal(pace, text.count, now)
        rendered = text
    }

    func advance() {
        guard seeded, pace.shown < Double(pace.target) else { return }
        pace = advanceReveal(pace, monotonicMs())
    }

    func visible(_ target: String) -> String { revealText(target, pace.shown) }
}

func monotonicMs() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }

struct StreamingMarkdown: View {
    let text: String

    let streaming: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pacer = RevealPacer()

    private var shown: String {
        streaming && !reduceMotion ? pacer.visible(text) : text
    }

    var body: some View {
        MarkdownText(text: shown)
            .onAppear { pacer.seed(text) }

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
